import * as core from "@actions/core";
import { context, getOctokit } from "@actions/github";
import { appendFileSync, copyFileSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { filterForPrompt, isLockfile, parseHunks, readPrMeta, truncateDiff, writePrMeta, type FileDiff, type PrMeta } from "./diff.js";
import { runL0, type Finding } from "./fastpath.js";
import { runL2 } from "./l2.js";
import { postIssueFallback, postReview, ReadonlyTokenError, resolvePrNumber, shouldTrigger } from "./github.js";
import { getInputs, type ActionInputs } from "./inputs.js";
import { callLlm, ensureOllama, type LlmResult } from "./llm.js";
import { buildMessages, linkedIssueNumber } from "./prompt.js";
import { resolveEndpoint, validateModelExists, type ResolvedEndpoint } from "./providers.js";
import { buildBody, eventFor, exitFor, mapToComments, type ReviewPayload } from "./review.js";
import { runScanners, type ScannerResult } from "./scanners.js";

/** Everything the run needs from the environment. Built by readRunEnv() in production. */
export interface RunEnv {
  eventName: string;
  payload: Record<string, unknown>;
  inputs: ActionInputs;
  /** Checkout of the PR head (the template checks it out detached at HEAD_SHA). */
  workDir: string;
  /** Holds diff.patch (written by the template), and receives pr-meta.json, findings.json, sbom. */
  artifactDir: string;
  baseSha: string;
  headSha: string;
  /** PR_REVIEWER_TOKEN_TYPE === "app". An App token may write on a fork PR. */
  tokenIsApp: boolean;
  /** PR_REVIEWER_ISSUE_FALLBACK === "true". The template grants issues: write for the fallback. */
  issueFallback: boolean;
  hasSemgrepToken: boolean;
  /** GITHUB_STEP_SUMMARY, when present. */
  summaryPath?: string;
}

export interface PrInfo {
  body: string;
  headSha: string;
  headRepo: string;
  isFork: boolean;
}

/** GitHub API boundary. Production wraps Octokit; tests inject fakes. */
export interface Gateway {
  getPr(pr: number): Promise<PrInfo>;
  getIssueBody(issue: number): Promise<string>;
  createReview(pr: number, payload: ReviewPayload, opts: { canWrite: boolean }): Promise<void>;
  createIssueComment(pr: number, body: string, opts: { enabled: boolean; issuesWrite: boolean }): Promise<void>;
}

/** Scanner, linter and LLM boundary. Never invoked by the privileged flow. */
export interface Analysis {
  runScanners(o: Parameters<typeof runScanners>[0]): Promise<ScannerResult>;
  runL2(dir: string): Promise<Finding[]>;
  ensureOllama(baseUrl: string, model: string, o: { timeoutSeconds?: number; apiKey?: string }): Promise<void>;
  validateModelExists(baseUrl: string, model: string, apiKey: string): Promise<boolean>;
  callLlm(ep: ResolvedEndpoint, messages: { system: string; user: string }, o: Parameters<typeof callLlm>[2]): Promise<LlmResult>;
}

export interface Deps {
  gh: Gateway;
  analysis: Analysis;
}

export interface Outcome {
  posted: boolean;
  summaryWritten: boolean;
  exitCode: number;
  findingsFrom: "llm" | "fastpath";
  slowPathSkipped: boolean;
  issueBodyFetched?: number;
}

interface EventFields {
  action?: string;
  comment?: { body?: string; author_association?: string };
  review?: { body?: string; author_association?: string };
  issue?: { number: number; pull_request?: unknown };
  pull_request?: { number: number };
  workflow_run?: { head_sha?: string };
}

const SHA_RE = /^[0-9a-f]{40}$/;
const SEVERITIES: ReadonlySet<string> = new Set(["info", "warning", "high"]);

/** Lockfile basename to the manifest that must change with it. Unmapped lockfiles are not flagged. */
const MANIFEST_FOR: Readonly<Record<string, string>> = {
  "package-lock.json": "package.json",
  "npm-shrinkwrap.json": "package.json",
  "pnpm-lock.yaml": "package.json",
  "yarn.lock": "package.json",
  "bun.lock": "package.json",
  "bun.lockb": "package.json",
  "Cargo.lock": "Cargo.toml",
  "go.sum": "go.mod",
  "Gemfile.lock": "Gemfile",
  "poetry.lock": "pyproject.toml",
  "uv.lock": "pyproject.toml",
  "Pipfile.lock": "Pipfile",
  "composer.lock": "composer.json",
  "pubspec.lock": "pubspec.yaml",
  "Podfile.lock": "Podfile",
  "flake.lock": "flake.nix",
};

function newOutcome(): Outcome {
  return { posted: false, summaryWritten: false, exitCode: 0, findingsFrom: "fastpath", slowPathSkipped: false };
}

function requireSha(name: string, value: string): void {
  if (!SHA_RE.test(value)) throw new Error(`pr-reviewer: ${name} must be a 40-character lowercase commit SHA`);
}

function readDiff(dir: string): string {
  const path = join(dir, "diff.patch");
  if (!existsSync(path)) throw new Error(`pr-reviewer: diff.patch not found in ${dir}`);
  return readFileSync(path, "utf8");
}

function sizeOf(workDir: string | undefined, file: string): number {
  if (workDir === undefined) return 0;
  try {
    return statSync(join(workDir, file)).size;
  } catch {
    return 0;
  }
}

/**
 * Splits `git diff -U3` output into per-file sections. `hunks` starts at the first `@@`, so
 * file headers never reach the hunk parsers. Binary sections are flagged from git's own text.
 */
function parseDiffFiles(text: string, workDir?: string): FileDiff[] {
  const sections: { file: string; lines: string[]; binary: boolean }[] = [];
  let cur: { file: string; lines: string[]; binary: boolean } | undefined;
  for (const line of text.split("\n")) {
    const head = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (head) {
      cur = { file: head[2], lines: [], binary: false };
      sections.push(cur);
      continue;
    }
    if (cur === undefined) continue;
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) cur.binary = true;
    cur.lines.push(line);
  }
  return sections.map((s) => {
    const at = s.lines.findIndex((l) => l.startsWith("@@"));
    const hunks = at === -1 ? "" : s.lines.slice(at).join("\n").replace(/\n+$/, "");
    const f: FileDiff = { file: s.file, hunks, truncated: false, size: hunks === "" ? 0 : sizeOf(workDir, s.file) };
    if (s.binary) f.binary = true;
    return f;
  });
}

function isFinding(v: unknown): v is Finding {
  if (typeof v !== "object" || v === null) return false;
  const f = v as Record<string, unknown>;
  return (
    typeof f.severity === "string" &&
    SEVERITIES.has(f.severity) &&
    typeof f.file === "string" &&
    typeof f.rule === "string" &&
    typeof f.message === "string" &&
    (f.line === undefined || (typeof f.line === "number" && Number.isInteger(f.line) && f.line >= 1)) &&
    (f.suggestion === undefined || typeof f.suggestion === "string")
  );
}

function readFindings(dir: string): Finding[] {
  const path = join(dir, "findings.json");
  if (!existsSync(path)) throw new Error(`pr-reviewer: findings.json not found in ${dir}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("pr-reviewer: findings.json is malformed JSON");
  }
  if (!Array.isArray(parsed) || !parsed.every(isFinding)) {
    throw new Error("pr-reviewer: findings.json does not match the finding contract");
  }
  return parsed;
}

function writeFindings(dir: string, findings: Finding[]): void {
  writeFileSync(join(dir, "findings.json"), JSON.stringify(findings, null, 2) + "\n", "utf8");
}

function fields(env: RunEnv): EventFields {
  return env.payload as EventFields;
}

function triggerFor(env: RunEnv): boolean {
  const p = fields(env);
  return shouldTrigger(env.eventName, {
    action: p.action,
    commentBody: p.comment?.body,
    reviewBody: p.review?.body,
    authorAssociation: p.comment?.author_association ?? p.review?.author_association,
    issueHasPR: p.issue?.pull_request !== undefined,
    prNumber: env.inputs.prNumber,
  });
}

function prNumberFor(env: RunEnv): number | null {
  if (env.eventName === "workflow_dispatch") return env.inputs.prNumber;
  return resolvePrNumber(env.eventName, env.payload as Parameters<typeof resolvePrNumber>[1]);
}

function summaryFor(findings: Finding[]): string {
  return findings.length === 0 ? "pr-reviewer: no findings." : `pr-reviewer: ${findings.length} finding(s).`;
}

/**
 * Slow path (LLM). Returns undefined when it is skipped: no key, nothing to send, bad config,
 * a failed model check, or a failed call. Every skip is a warning; the fast path still posts.
 */
async function slowPath(
  env: RunEnv,
  deps: Deps,
  pr: number,
  fast: Finding[],
  promptText: string,
  issueBody: string | undefined,
  skipped: string[],
): Promise<Finding[] | undefined> {
  const i = env.inputs;
  if (i.llmApiKey === "") {
    core.info("no llm_api_key: slow path skipped");
    return undefined;
  }
  if (promptText.trim() === "") {
    core.info("no prompt-able files in this change: slow path skipped");
    return undefined;
  }
  if (i.llmModel === "") {
    core.warning("llm_model is empty: slow path skipped");
    return undefined;
  }
  let ep: ResolvedEndpoint;
  try {
    ep = resolveEndpoint({
      llmProvider: i.llmProvider,
      llmBaseUrl: i.llmBaseUrl,
      llmApiStyle: i.llmApiStyle,
      llmPath: i.llmPath,
      llmModel: i.llmModel,
      llmApiKey: i.llmApiKey,
      prNumber: pr,
    });
  } catch (e) {
    core.warning(`slow path skipped: ${(e as Error).message}`);
    return undefined;
  }
  if (i.llmProvider === "ollama") {
    try {
      await deps.analysis.ensureOllama(ep.baseUrl, i.llmModel, { timeoutSeconds: i.timeoutSeconds, apiKey: i.llmApiKey });
    } catch (e) {
      core.warning(`slow path skipped: ${(e as Error).message}`);
      return undefined;
    }
  }
  try {
    const listed = await deps.analysis.validateModelExists(ep.baseUrl, i.llmModel, i.llmApiKey);
    if (!listed) {
      core.warning(`slow path skipped: model "${i.llmModel}" is not listed by the provider`);
      return undefined;
    }
  } catch (e) {
    core.warning(`slow path skipped: model check failed: ${(e as Error).message}`);
    return undefined;
  }
  const messages = buildMessages(fast, promptText, issueBody, skipped);
  const res = await deps.analysis.callLlm(ep, messages, {
    model: i.llmModel,
    apiKey: i.llmApiKey,
    temperature: i.llmTemperature,
    topP: i.llmTopP,
    maxTokens: i.llmMaxTokens,
    timeoutSeconds: i.timeoutSeconds,
    provider: i.llmProvider,
  });
  if (!res.ok) {
    core.warning(`slow path failed (${res.reason}): ${res.detail}`);
    return undefined;
  }
  return res.findings;
}

interface PublishArgs {
  env: RunEnv;
  deps: Deps;
  out: Outcome;
  pr: number;
  isFork: boolean;
  findings: Finding[];
  hunks: FileDiff[];
  headSha: string;
}

/**
 * Posts one review for `headSha`, or dry-runs it. Writes the summary in every case. Posts only
 * when the token can write and the PR head still equals `headSha` (checked via the API).
 */
async function publishReview(a: PublishArgs): Promise<void> {
  const { inline, general } = mapToComments(a.findings, parseHunks(a.hunks));
  const body = buildBody(general, summaryFor(a.findings));
  const payload: ReviewPayload = {
    commit_id: a.headSha,
    body,
    event: eventFor(a.env.inputs.failLevel, a.findings),
    comments: inline,
  };
  if (a.env.summaryPath !== undefined) {
    appendFileSync(a.env.summaryPath, body + "\n", "utf8");
    a.out.summaryWritten = true;
  }
  if (!a.env.inputs.postComment) {
    core.info("post_comment is false: dry-run, nothing posted");
    return;
  }
  const canWrite = !a.isFork || a.env.tokenIsApp;
  if (!canWrite) {
    core.warning("fork PR with a read-only token: review not posted; summary and artifact only");
    return;
  }
  const live = await a.deps.gh.getPr(a.pr);
  if (live.headSha !== a.headSha) {
    core.warning(`PR head moved from ${a.headSha} to ${live.headSha}: skipping review for the stale head`);
    return;
  }
  try {
    await a.deps.gh.createReview(a.pr, payload, { canWrite: true });
    a.out.posted = true;
  } catch (e) {
    if (!(e instanceof ReadonlyTokenError)) throw e;
    core.error(`review post refused by GitHub: ${e.detail !== "" ? e.detail : e.message}`);
    const issuesWrite = a.env.issueFallback && canWrite;
    if (!issuesWrite) {
      core.warning("issue fallback unavailable (not enabled, or token lacks issues: write); nothing posted");
      return;
    }
    await a.deps.gh.createIssueComment(a.pr, body, { enabled: a.env.issueFallback, issuesWrite });
    a.out.posted = true;
  }
}

/** Fluxo A: pull_request / issue_comment / review / dispatch. Diff comes from the template. */
async function runFlowA(env: RunEnv, deps: Deps, out: Outcome): Promise<void> {
  out.slowPathSkipped = true;
  if (!triggerFor(env)) {
    core.info(`event "${env.eventName}" does not trigger a review`);
    return;
  }
  const pr = prNumberFor(env);
  if (pr === null) {
    core.info("no pull request for this event: nothing to review");
    return;
  }
  requireSha("PR_REVIEWER_BASE_SHA", env.baseSha);
  requireSha("PR_REVIEWER_HEAD_SHA", env.headSha);

  // Unfiltered list: L0 needs lockfiles and binaries (Task 4 contract).
  const files = parseDiffFiles(readDiff(env.artifactDir), env.workDir);
  const pull = await deps.gh.getPr(pr);
  const meta: PrMeta = {
    pr_number: pr,
    head_sha: env.headSha,
    base_sha: env.baseSha,
    head_repo_full_name: pull.headRepo,
    is_fork: pull.isFork,
  };
  writePrMeta(meta, env.artifactDir);

  const changedNames = new Set(files.map((f) => basename(f.file)));
  const l0 = runL0(files, {
    hasManifestFor: (lock) => {
      const manifest = MANIFEST_FOR[lock];
      return manifest === undefined || changedNames.has(manifest);
    },
  });
  const lockfiles = files.filter((f) => isLockfile(f.file)).map((f) => f.file);
  const scan = await deps.analysis.runScanners({
    dir: env.workDir,
    baselineSha: env.baseSha,
    hasSemgrepToken: env.hasSemgrepToken,
    sbom: true,
    lockfiles,
    outDir: env.artifactDir,
  });
  if (scan.sbomPath !== undefined) {
    try {
      copyFileSync(scan.sbomPath, join(env.artifactDir, "sbom.cdx.json"));
    } finally {
      rmSync(dirname(scan.sbomPath), { recursive: true, force: true });
    }
  }
  const l2 = await deps.analysis.runL2(env.workDir);
  const fast = [...l0, ...scan.findings, ...l2];
  // Written before the LLM call so a later failure still leaves the fast results uploadable.
  writeFindings(env.artifactDir, fast);

  const prompt = truncateDiff(filterForPrompt(files), env.inputs.maxDiffChars, env.inputs.maxDiffChars);
  let issueBody: string | undefined;
  const issueNo = linkedIssueNumber(pull.body);
  if (issueNo !== null) {
    try {
      issueBody = await deps.gh.getIssueBody(issueNo);
      out.issueBodyFetched = issueNo;
    } catch (e) {
      core.warning(`linked issue #${issueNo} not fetched: ${(e as Error).message}`);
    }
  }

  const llm = await slowPath(env, deps, pr, fast, prompt.text, issueBody, prompt.skipped);
  out.slowPathSkipped = llm === undefined;
  out.findingsFrom = llm === undefined ? "fastpath" : "llm";
  const all = [...fast, ...(llm ?? [])];
  writeFindings(env.artifactDir, all);

  await publishReview({ env, deps, out, pr, isFork: pull.isFork, findings: all, hunks: files, headSha: env.headSha });
  out.exitCode = exitFor(env.inputs.failLevel, all);
}

/**
 * Fluxo B: workflow_run, privileged. Only reads the artifact of the PR run and posts. It never
 * checks out code, runs scanners or calls the LLM. The artifact came from a run that executed
 * PR code, so it is bound to the trusted workflow_run.head_sha and to the live PR head.
 */
async function runFlowB(env: RunEnv, deps: Deps, out: Outcome): Promise<void> {
  out.slowPathSkipped = true;
  const meta = readPrMeta(env.artifactDir);
  if (meta === undefined) {
    throw new Error(
      `pr-reviewer: pr-meta.json not found in ${env.artifactDir}; refusing to post without the PR run's artifact`,
    );
  }
  const runHead = fields(env).workflow_run?.head_sha;
  if (runHead !== meta.head_sha) {
    throw new Error("pr-reviewer: artifact head_sha does not match workflow_run.head_sha; refusing to post");
  }
  const findings = readFindings(env.artifactDir);
  const hunks = parseDiffFiles(readDiff(env.artifactDir));
  const live = await deps.gh.getPr(meta.pr_number);
  await publishReview({
    env,
    deps,
    out,
    pr: meta.pr_number,
    isFork: live.isFork,
    findings,
    hunks,
    headSha: meta.head_sha,
  });
  out.exitCode = exitFor(env.inputs.failLevel, findings);
}

/** Runs one review. Returns the outcome; the caller maps exitCode to the process. */
export async function run(env: RunEnv, deps: Deps): Promise<Outcome> {
  const out = newOutcome();
  if (env.eventName === "workflow_run") await runFlowB(env, deps, out);
  else await runFlowA(env, deps, out);
  return out;
}

function realGateway(token: string): Gateway {
  const octokit = getOctokit(token);
  return {
    async getPr(pr) {
      const { owner, repo } = context.repo;
      const r = await octokit.rest.pulls.get({ owner, repo, pull_number: pr });
      const headRepo = r.data.head.repo?.full_name ?? "";
      return {
        body: r.data.body ?? "",
        headSha: r.data.head.sha,
        headRepo,
        isFork: headRepo !== r.data.base.repo.full_name,
      };
    },
    async getIssueBody(issue) {
      const { owner, repo } = context.repo;
      const r = await octokit.rest.issues.get({ owner, repo, issue_number: issue });
      return r.data.body ?? "";
    },
    createReview: (pr, payload, opts) => postReview(octokit, pr, payload, { canWrite: opts.canWrite }).then(() => undefined),
    createIssueComment: (pr, body, opts) => postIssueFallback(octokit, { pr, body, ...opts }),
  };
}

function realAnalysis(): Analysis {
  return {
    runScanners,
    runL2: (dir) => runL2(dir),
    ensureOllama,
    validateModelExists,
    callLlm,
  };
}

/** Reads the real environment. Throws on invalid action inputs. */
export function readRunEnv(): RunEnv {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const payload: Record<string, unknown> =
    eventPath !== undefined && eventPath !== "" ? (JSON.parse(readFileSync(eventPath, "utf8")) as Record<string, unknown>) : {};
  const inputs = getInputs();
  return {
    eventName: process.env.GITHUB_EVENT_NAME ?? "",
    payload,
    inputs,
    workDir: process.env.GITHUB_WORKSPACE ?? process.cwd(),
    artifactDir: process.env.PR_REVIEWER_ARTIFACT_DIR ?? join(process.env.RUNNER_TEMP ?? tmpdir(), "pr-reviewer-out"),
    baseSha: process.env.PR_REVIEWER_BASE_SHA ?? "",
    headSha: process.env.PR_REVIEWER_HEAD_SHA ?? "",
    tokenIsApp: process.env.PR_REVIEWER_TOKEN_TYPE === "app",
    issueFallback: process.env.PR_REVIEWER_ISSUE_FALLBACK === "true",
    hasSemgrepToken: (process.env.SEMGREP_APP_TOKEN ?? "") !== "",
    ...(process.env.GITHUB_STEP_SUMMARY ? { summaryPath: process.env.GITHUB_STEP_SUMMARY } : {}),
  };
}

export async function main(): Promise<void> {
  const env = readRunEnv();
  const out = await run(env, { gh: realGateway(env.inputs.githubToken), analysis: realAnalysis() });
  core.setOutput("exit-code", String(out.exitCode));
  process.exitCode = out.exitCode;
}

const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  main().catch((err: unknown) => {
    core.setFailed(err instanceof Error ? err.message : String(err));
  });
}
