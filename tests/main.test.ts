import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as core from "@actions/core";
import { afterEach, describe, expect, it, vi } from "vitest";

// Wrap core.info in a spy (ESM namespaces cannot be spied on directly); behavior is unchanged.
vi.mock("@actions/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@actions/core")>();
  return { ...actual, info: vi.fn(actual.info) };
});
import { cleanEnvForExec, run, sanitizeFinding, unquoteGitPath, type Deps, type Gateway, type PrInfo, type RunEnv } from "../src/main.js";
import type { ActionInputs } from "../src/inputs.js";
import { ReadonlyTokenError } from "../src/github.js";
import type { ReviewPayload } from "../src/review.js";
import type { Finding } from "../src/fastpath.js";

const SHA_HEAD = "a".repeat(40);
const SHA_OTHER = "c".repeat(40);
const SHA_BASE = "b".repeat(40);

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 const x = 1;
+const y = 2;
 export {};
`;

const BINARY = `diff --git a/img.png b/img.png
index 111..222 100644
Binary files a/img.png and b/img.png differ
`;

/** Git's default quoting of a non-ASCII name (core.quotePath=true): UTF-8 bytes as octal escapes. */
const QUOTED_BINARY = [
  'diff --git "a/caf\\303\\251.bin" "b/caf\\303\\251.bin"',
  'Binary files "a/caf\\303\\251.bin" and "b/caf\\303\\251.bin" differ',
  "",
].join("\n");

const LLM_FINDING: Finding = {
  severity: "warning",
  file: "src/a.ts",
  line: 2,
  rule: "logic",
  message: "llm message",
};

const TRUNC = "…[truncated]";

const created: string[] = [];

afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratch(): string {
  mkdirSync("/tmp/opencode", { recursive: true });
  const d = mkdtempSync("/tmp/opencode/pr-main-");
  created.push(d);
  return d;
}

interface Rec {
  reviews: ReviewPayload[];
  reviewAttempts: number;
  issueComments: string[];
  getPrCalls: number;
  issueBodyFetched?: number;
  llmCalled: number;
  ollamaCalled: number;
  scanEnv?: NodeJS.ProcessEnv;
  l2Env?: NodeJS.ProcessEnv;
}

function newRec(): Rec {
  return { reviews: [], reviewAttempts: 0, issueComments: [], getPrCalls: 0, llmCalled: 0, ollamaCalled: 0 };
}

interface GwOpts {
  prsByHead?: number[];
  write403?: boolean;
  issue403?: boolean;
  body?: string;
  /** Second and later getPr calls report a moved head. */
  headMoves?: boolean;
  info?: Partial<PrInfo>;
}

function gatewayFor(rec: Rec, o: GwOpts): Gateway {
  const base: PrInfo = {
    body: o.body ?? "",
    headSha: SHA_HEAD,
    headRepo: "o/r",
    headRef: "feature",
    isFork: false,
    ...o.info,
  };
  return {
    findPrsByHead: async () => o.prsByHead ?? [7],
    getPr: async () => {
      rec.getPrCalls += 1;
      if (o.headMoves && rec.getPrCalls > 1) return { ...base, headSha: SHA_OTHER };
      return base;
    },
    getIssueBody: async (n) => {
      rec.issueBodyFetched = n;
      return "issue text";
    },
    createReview: async (_pr, payload) => {
      rec.reviewAttempts += 1;
      if (o.write403) {
        throw new ReadonlyTokenError("review post refused", 403, "Resource not accessible by integration");
      }
      rec.reviews.push(payload);
    },
    createIssueComment: async (_pr, body) => {
      if (o.issue403) throw new Error("issue comment refused (HTTP 403)");
      rec.issueComments.push(body);
    },
  };
}

function inputsFor(o: MockOpts): ActionInputs {
  return {
    githubToken: "t",
    llmProvider: "openai",
    llmBaseUrl: "https://llm.example/v1",
    llmApiStyle: "auto",
    llmPath: "",
    llmModel: "gpt-test",
    llmApiKey: o.llmApiKey ?? "k",
    llmMaxTokens: 2000,
    failLevel: o.failLevel ?? "warning",
    maxDiffChars: 60000,
    postComment: o.postComment ?? true,
    timeoutSeconds: 90,
    prNumber: o.prNumber === undefined ? 7 : o.prNumber,
  };
}

interface MockOpts {
  llmApiKey?: string;
  prBody?: string;
  forkReadonly?: boolean;
  postComment?: boolean;
  binaryOnly?: boolean;
  prNumber?: number | null;
  validateModel?: boolean | "reject";
  write403?: boolean;
  issueFallback?: boolean;
  issue403?: boolean;
  failLevel?: "none" | "warning" | "high";
  llm?: Finding[];
  headMoves?: boolean;
  diff?: string;
  action?: string;
  sbomMissing?: boolean;
  /** Re-trigger via an issue comment (non-pull_request event). */
  comment?: boolean;
  tokenIsApp?: boolean;
}

async function runWithMocks(o: MockOpts = {}) {
  const root = scratch();
  const artifactDir = join(root, "out");
  mkdirSync(artifactDir);
  writeFileSync(join(artifactDir, "diff.patch"), o.diff ?? (o.binaryOnly ? BINARY : DIFF));
  const summaryPath = join(root, "summary.md");
  writeFileSync(summaryPath, "");
  const rec = newRec();
  const sbomDir = join(root, "sbom-x");
  if (o.sbomMissing) mkdirSync(sbomDir);

  const commentPayload = {
    action: "created",
    comment: { body: "/review", author_association: "MEMBER" },
    issue: { number: 7, pull_request: { url: "https://api.example/pulls/7" } },
  };
  const env: RunEnv = {
    eventName: o.comment ? "issue_comment" : o.prNumber === null ? "workflow_dispatch" : "pull_request",
    payload: o.comment
      ? commentPayload
      : o.prNumber === null
        ? {}
        : { action: o.action ?? "synchronize", pull_request: { number: 7 } },
    inputs: inputsFor(o),
    workDir: root,
    artifactDir,
    baseSha: SHA_BASE,
    headSha: SHA_HEAD,
    tokenIsApp: o.tokenIsApp === true,
    issueFallback: o.issueFallback === true,
    summaryPath,
  };

  const deps: Deps = {
    gh: gatewayFor(rec, {
      write403: o.write403,
      issue403: o.issue403,
      headMoves: o.headMoves,
      body: o.prBody,
      info: { isFork: o.forkReadonly === true, headRepo: o.forkReadonly ? "fork/r" : "o/r" },
    }),
    analysis: {
      runScanners: async () => {
        rec.scanEnv = { ...process.env };
        return o.sbomMissing ? { findings: [], sbomPath: join(sbomDir, "sbom.cdx.json") } : { findings: [] };
      },
      runL2: async () => {
        rec.l2Env = { ...process.env };
        return [];
      },
      ensureOllama: async () => {
        rec.ollamaCalled += 1;
      },
      validateModelExists: async () => {
        if (o.validateModel === "reject") throw new Error("GET /models failed with HTTP 500");
        return o.validateModel !== false;
      },
      callLlm: async () => {
        rec.llmCalled += 1;
        return { ok: true, findings: o.llm ?? [LLM_FINDING] };
      },
    },
  };

  const out = await run(env, deps);
  return {
    ...out,
    issueBodyFetched: rec.issueBodyFetched,
    reviews: rec.reviews,
    reviewAttempts: rec.reviewAttempts,
    issueComments: rec.issueComments,
    getPrCalls: rec.getPrCalls,
    body: rec.reviews.at(-1)?.body,
    llmCalled: rec.llmCalled,
    scanEnv: rec.scanEnv,
    l2Env: rec.l2Env,
    artifactDir,
    summaryPath,
    sbomDir,
  };
}

interface PrivOpts {
  metaPr?: number;
  prsByHead?: number[];
  findings?: unknown[];
  metaHead?: string;
  wrHead?: string;
  wrRepo?: string | null;
  wrBranch?: string;
  liveRepo?: string;
  liveRef?: string;
  liveSha?: string;
  diff?: string;
}

/** Fluxo B. Analysis methods throw: the privileged flow must never call scanners, L2 or the LLM. */
async function runPrivileged(o: PrivOpts = {}) {
  const root = scratch();
  const artifactDir = join(root, "priv");
  mkdirSync(artifactDir);
  writeFileSync(
    join(artifactDir, "pr-meta.json"),
    JSON.stringify({
      pr_number: o.metaPr ?? 7,
      head_sha: o.metaHead ?? SHA_HEAD,
      base_sha: SHA_BASE,
      head_repo_full_name: "o/r",
      is_fork: false,
    }),
  );
  writeFileSync(join(artifactDir, "findings.json"), JSON.stringify(o.findings ?? [LLM_FINDING]));
  writeFileSync(join(artifactDir, "diff.patch"), o.diff ?? DIFF);
  const env: RunEnv = {
    eventName: "workflow_run",
    payload: {
      workflow_run: {
        id: 99,
        head_sha: o.wrHead ?? SHA_HEAD,
        head_branch: o.wrBranch ?? "feature",
        head_repository: o.wrRepo === null ? null : { full_name: o.wrRepo ?? "o/r" },
        event: "pull_request",
        conclusion: "success",
      },
    },
    inputs: inputsFor({}),
    workDir: root,
    artifactDir,
    baseSha: SHA_BASE,
    headSha: SHA_HEAD,
    tokenIsApp: false,
    issueFallback: false,
  };
  const rec = newRec();
  const spyFail = (name: string) => () => {
    throw new Error(`${name} must not be invoked in the privileged flow`);
  };
  const deps: Deps = {
    gh: gatewayFor(rec, {
      prsByHead: o.prsByHead,
      info: { headRepo: o.liveRepo ?? "o/r", headRef: o.liveRef ?? "feature", headSha: o.liveSha ?? SHA_HEAD },
    }),
    analysis: {
      runScanners: spyFail("scanners"),
      runL2: spyFail("l2"),
      ensureOllama: spyFail("ollama"),
      validateModelExists: spyFail("models"),
      callLlm: spyFail("llm"),
    },
  };
  const out = await run(env, deps);
  return { ...out, reviews: rec.reviews, payloads: rec.reviews, reviewAttempts: rec.reviewAttempts };
}

describe("run() orchestration", () => {
  it("no llm key still posts fast-path review", async () => {
    const r = await runWithMocks({ llmApiKey: "" });
    expect(r.posted).toBe(true);
    expect(r.findingsFrom).toBe("fastpath");
    expect(r.llmCalled).toBe(0);
  });

  it("linked issue body enriches prompt when Fixes #n", async () => {
    const r = await runWithMocks({ prBody: "Fixes #12" });
    expect(r.issueBodyFetched).toBe(12);
  });

  it("fork readonly posts nothing, writes summary + artifact", async () => {
    const r = await runWithMocks({ forkReadonly: true });
    expect(r.posted).toBe(false);
    expect(r.summaryWritten).toBe(true);
    expect(r.reviewAttempts).toBe(0);
    expect(readFileSync(join(r.artifactDir, "diff.patch"), "utf8")).toContain("src/a.ts");
    expect(readFileSync(join(r.artifactDir, "pr-meta.json"), "utf8")).toContain('"is_fork": true');
  });

  it("privileged flow posts the artifact review", async () => {
    const calls = await runPrivileged();
    expect(calls.posted).toBe(true);
    expect(calls.payloads).toHaveLength(1);
  });

  it("post_comment false and resolve-null/binary dry-run without post", async () => {
    const r = await runWithMocks({ postComment: false });
    expect(r.posted).toBe(false);
    const b = await runWithMocks({ binaryOnly: true });
    expect(b.posted).toBe(true);
    expect(b.slowPathSkipped).toBe(true);
    expect(b.exitCode).toBe(0);
    expect(b.body).toContain("binary-note");
    const n = await runWithMocks({ prNumber: null });
    expect(n.posted).toBe(false);
    expect(n.exitCode).toBe(0);
  });

  it("dry-run logs the event and finding counts it would have posted", async () => {
    const info = vi.mocked(core.info);
    info.mockClear();
    const r = await runWithMocks({ postComment: false });
    expect(r.posted).toBe(false);
    const lines = info.mock.calls.map((c) => String(c[0]));
    const dry = lines.find((l) => l.includes("dry-run, nothing posted"));
    // Fixture: one warning finding on src/a.ts:2, which is an added line in DIFF, so it maps inline.
    expect(dry).toBe(
      "post_comment is false: dry-run, nothing posted (would post event=COMMENT, inline=1, general=0, high=0)",
    );
  });

  it("dry-run counts high findings and REQUEST_CHANGES with fail_level high", async () => {
    const info = vi.mocked(core.info);
    info.mockClear();
    const high: Finding = { ...LLM_FINDING, severity: "high", message: "high message" };
    const r = await runWithMocks({ postComment: false, failLevel: "high", llm: [high] });
    expect(r.posted).toBe(false);
    const dry = info.mock.calls.map((c) => String(c[0])).find((l) => l.includes("dry-run, nothing posted"));
    expect(dry).toBe(
      "post_comment is false: dry-run, nothing posted (would post event=REQUEST_CHANGES, inline=1, general=0, high=1)",
    );
  });

  it("validateModelExists rejection skips the slow path with a warning but still posts fast-path", async () => {
    const r = await runWithMocks({ validateModel: "reject" });
    expect(r.posted).toBe(true);
    expect(r.slowPathSkipped).toBe(true);
    expect(r.findingsFrom).toBe("fastpath");
    expect(r.llmCalled).toBe(0);
  });

  it("missing pr-meta.json in the privileged flow is a clear error and posts nothing", async () => {
    const root = scratch();
    const artifactDir = join(root, "empty");
    mkdirSync(artifactDir);
    writeFileSync(join(artifactDir, "diff.patch"), DIFF);
    writeFileSync(join(artifactDir, "findings.json"), "[]");
    const rec = newRec();
    const env: RunEnv = {
      eventName: "workflow_run",
      payload: { workflow_run: { head_sha: SHA_HEAD } },
      inputs: inputsFor({}),
      workDir: root,
      artifactDir,
      baseSha: SHA_BASE,
      headSha: SHA_HEAD,
      tokenIsApp: true,
      issueFallback: false,
    };
    const deps: Deps = {
      gh: gatewayFor(rec, {}),
      analysis: {
        runScanners: () => {
          throw new Error("scanners must not run");
        },
        runL2: () => {
          throw new Error("l2 must not run");
        },
        ensureOllama: () => {
          throw new Error("ollama must not run");
        },
        validateModelExists: () => {
          throw new Error("models must not run");
        },
        callLlm: () => {
          throw new Error("llm must not run");
        },
      },
    };
    await expect(run(env, deps)).rejects.toThrow(/pr-meta\.json/);
    expect(rec.reviews).toHaveLength(0);
  });

  it("stale head: the review is skipped when the PR head moved before the POST", async () => {
    const r = await runWithMocks({ headMoves: true });
    expect(r.posted).toBe(false);
    expect(r.reviewAttempts).toBe(0);
    expect(r.getPrCalls).toBe(2);
  });

  it("ReadonlyTokenError on a writable token (real 403 path) posts nothing and is not a crash", async () => {
    const r = await runWithMocks({ write403: true });
    expect(r.reviewAttempts).toBe(1);
    expect(r.posted).toBe(false);
    expect(r.issueComments).toHaveLength(0);
    expect(r.summaryWritten).toBe(true);
  });

  it("issue fallback posts a summary comment when the review is refused and fallback is enabled", async () => {
    const r = await runWithMocks({ write403: true, issueFallback: true });
    expect(r.reviewAttempts).toBe(1);
    expect(r.issueComments).toHaveLength(1);
    expect(r.issueComments[0]).toContain("pr-reviewer: 1 finding(s).");
    expect(r.posted).toBe(true);
  });

  it("fallback 403 + fail_level none: warning only, exit 0, posted false", async () => {
    const r = await runWithMocks({ write403: true, issueFallback: true, issue403: true, failLevel: "none" });
    expect(r.posted).toBe(false);
    expect(r.exitCode).toBe(0);
  });

  it("fail_level high exits 1 on high-severity evidence through run()", async () => {
    const high: Finding = { severity: "high", file: "src/a.ts", line: 2, rule: "sec", message: "bad" };
    const r = await runWithMocks({ failLevel: "high", llm: [high] });
    expect(r.exitCode).toBe(1);
    expect(r.posted).toBe(true);
  });

  it("fail_level warning exits 2 on warning findings through run()", async () => {
    const r = await runWithMocks({ failLevel: "warning" });
    expect(r.exitCode).toBe(2);
    expect(r.posted).toBe(true);
  });

  it("a non-triggering event is a no-op with exit 0 and no API calls", async () => {
    const r = await runWithMocks({ action: "closed" });
    expect(r.posted).toBe(false);
    expect(r.exitCode).toBe(0);
    expect(r.getPrCalls).toBe(0);
    expect(r.llmCalled).toBe(0);
  });

  it("scanners and L2 see a scrubbed env; the parent env is restored afterwards", async () => {
    const saved = { ...process.env };
    process.env.PR_TEST_API_TOKEN = "t-secret";
    process.env.MY_SERVICE_KEY = "k-secret";
    process.env.GITHUB_TOKEN = "ghs_secret";
    process.env.ACTIONS_RUNTIME_TOKEN = "rt-secret";
    process.env.RUNNER_TEMP = "/tmp/opencode/rt";
    try {
      const r = await runWithMocks({});
      for (const env of [r.scanEnv, r.l2Env]) {
        expect(env).toBeDefined();
        expect(env?.PR_TEST_API_TOKEN).toBeUndefined();
        expect(env?.MY_SERVICE_KEY).toBeUndefined();
        expect(env?.GITHUB_TOKEN).toBeUndefined();
        expect(env?.ACTIONS_RUNTIME_TOKEN).toBeUndefined();
        expect(env?.PATH).toBe(process.env.PATH);
        expect(env?.RUNNER_TEMP).toBe("/tmp/opencode/rt");
      }
      expect(process.env.PR_TEST_API_TOKEN).toBe("t-secret");
      expect(process.env.GITHUB_TOKEN).toBe("ghs_secret");
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });

  it("the LLM slow path keeps its key (not scrubbed; it is intended API use)", async () => {
    const r = await runWithMocks({ llmApiKey: "sk-live" });
    expect(r.llmCalled).toBe(1);
  });

  it("a failed sbom copy is a warning and the run continues", async () => {
    const r = await runWithMocks({ sbomMissing: true });
    expect(r.posted).toBe(true);
    expect(existsSync(r.sbomDir)).toBe(false);
  });

  it("writes sarif.json from the final findings (code scanning input)", async () => {
    const r = await runWithMocks({});
    const sarif = JSON.parse(readFileSync(join(r.artifactDir, "sarif.json"), "utf8")) as {
      version: string;
      runs: { results: { ruleId: string; locations: unknown[] }[] }[];
    };
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0].results[0].ruleId).toBe("logic");
    expect(sarif.runs[0].results[0].locations).toHaveLength(1);
  });

  it("fork PR re-triggered by comment with an App token: L2 is skipped, a finding says so, the review still posts", async () => {
    const r = await runWithMocks({ comment: true, forkReadonly: true, tokenIsApp: true });
    expect(r.l2Env).toBeUndefined();
    expect(r.body).toContain("l2-skipped");
    expect(r.posted).toBe(true);
  });

  it("same-repo comment re-trigger still runs L2", async () => {
    const r = await runWithMocks({ comment: true });
    expect(r.l2Env).toBeDefined();
    expect(r.body).not.toContain("l2-skipped");
  });

  it("quoted non-ASCII git paths decode to real names (quotePath residue)", async () => {
    const r = await runWithMocks({ diff: QUOTED_BINARY });
    expect(r.body).toContain("café.bin");
    expect(r.body).not.toContain("caf\\303");
  });
});

describe("Fluxo B bindings and sanitizing", () => {
  it("rejects when the live PR head repository differs from workflow_run.head_repository", async () => {
    await expect(runPrivileged({ liveRepo: "evil/r" })).rejects.toThrow(/head repository/);
  });

  it("rejects a same-sha different PR (head branch differs)", async () => {
    await expect(runPrivileged({ liveRef: "other-branch" })).rejects.toThrow(/head branch/);
  });

  it("rejects when artifact head_sha differs from workflow_run.head_sha", async () => {
    await expect(runPrivileged({ metaHead: SHA_OTHER })).rejects.toThrow(/workflow_run\.head_sha/);
  });

  it("rejects when the live PR head moved after the PR run", async () => {
    await expect(runPrivileged({ liveSha: SHA_OTHER })).rejects.toThrow(/live PR head/);
  });

  it("rejects when no open PR has the workflow_run head", async () => {
    await expect(runPrivileged({ prsByHead: [] })).rejects.toThrow(/exactly one open PR/);
  });

  it("rejects when more than one open PR has the workflow_run head", async () => {
    await expect(runPrivileged({ prsByHead: [7, 9] })).rejects.toThrow(/exactly one open PR/);
  });

  it("rejects when the artifact pr_number is not the PR derived from trusted fields", async () => {
    await expect(runPrivileged({ metaPr: 8, prsByHead: [7] })).rejects.toThrow(/does not match the PR derived/);
  });

  it("accepts an uppercase artifact head_sha (compared lowercased) and posts", async () => {
    const r = await runPrivileged({ metaHead: SHA_HEAD.toUpperCase() });
    expect(r.posted).toBe(true);
  });

  it("strips C0 controls from messages (keeps tab and newline) and caps file and rule lengths", async () => {
    const f: Finding = {
      severity: "warning",
      file: "src/a.ts",
      line: 2,
      rule: "r".repeat(150),
      message: "abc\u0007def\nline\tend\u0000",
    };
    const r = await runPrivileged({ findings: [f] });
    const body = r.payloads[0].comments[0].body;
    expect(body).toContain("abcdef\nline\tend");
    expect(body).not.toContain("\u0007");
    expect(body).not.toContain("r".repeat(100));
    expect(body).toContain(TRUNC);
  });

  it("caps file paths at 200 chars (over-long safe path becomes a capped general note)", async () => {
    const f: Finding = { severity: "warning", file: "d/".repeat(150), line: 2, rule: "r", message: "m" };
    const r = await runPrivileged({ findings: [f] });
    expect(r.payloads[0].body).not.toContain("d/".repeat(120));
    expect(r.payloads[0].body).toContain(TRUNC);
  });

  it("caps by code points: an emoji message never leaves a lone surrogate", async () => {
    const f: Finding = { severity: "warning", file: "src/a.ts", line: 2, rule: "r", message: "😀".repeat(2500) };
    const r = await runPrivileged({ findings: [f] });
    const body = r.payloads[0].comments[0].body;
    expect(body).toContain(TRUNC);
    expect(body).not.toContain("😀".repeat(2000));
    expect(body).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it("caps long messages at 2000 chars and marks the truncation", async () => {
    const f: Finding = { severity: "warning", file: "src/a.ts", line: 2, rule: "r", message: "x".repeat(5000) };
    const r = await runPrivileged({ findings: [f] });
    const body = r.payloads[0].comments[0].body;
    expect(body).toContain(TRUNC);
    expect(body).not.toContain("x".repeat(2000));
  });

  it("caps long suggestions at 4000 chars and marks the truncation", async () => {
    const f: Finding = {
      severity: "warning",
      file: "src/a.ts",
      line: 2,
      rule: "r",
      message: "m",
      suggestion: "y".repeat(6000),
    };
    const r = await runPrivileged({ findings: [f] });
    const body = r.payloads[0].comments[0].body;
    expect(body).toContain(TRUNC);
    expect(body).not.toContain("y".repeat(4000));
  });

  it("a parent-traversal path becomes a repository-level note, never an inline comment", async () => {
    const f: Finding = { severity: "warning", file: "../../etc/passwd", line: 2, rule: "r", message: "m" };
    const r = await runPrivileged({ findings: [f] });
    expect(r.payloads[0].comments).toHaveLength(0);
    expect(r.payloads[0].body).toContain("artifact path rejected");
    expect(r.payloads[0].body).toContain("(repository)");
  });

  it("an absolute path becomes a repository-level note", async () => {
    const f: Finding = { severity: "warning", file: "/etc/passwd", line: 2, rule: "r", message: "m" };
    const r = await runPrivileged({ findings: [f] });
    expect(r.payloads[0].comments).toHaveLength(0);
    expect(r.payloads[0].body).toContain("artifact path rejected");
  });

  it("sanitizeFinding keeps short findings unchanged", () => {
    expect(sanitizeFinding(LLM_FINDING)).toEqual(LLM_FINDING);
  });
});

describe("exec env and git path helpers", () => {
  it("cleanEnvForExec keeps the allowlist and strips every secret-shaped name", () => {
    const clean = cleanEnvForExec({
      PATH: "/bin",
      HOME: "/h",
      LANG: "C",
      TMPDIR: "/t",
      RUNNER_TEMP: "/r",
      GITHUB_WORKSPACE: "/w",
      GITHUB_TOKEN: "x",
      ACTIONS_RUNTIME_TOKEN: "x",
      LLM_API_KEY: "x",
      DB_PASSWORD: "x",
      SOME_SECRET: "x",
      AWS_AUTH_HEADER: "x",
      RANDOM_VAR: "x",
      SEMGREP_APP_TOKEN: "x",
    });
    expect(Object.keys(clean).sort()).toEqual(["GITHUB_WORKSPACE", "HOME", "LANG", "PATH", "RUNNER_TEMP", "TMPDIR"]);
  });

  it("unquoteGitPath decodes octal escapes and passes plain names through", () => {
    expect(unquoteGitPath('"caf\\303\\251.txt"')).toBe("café.txt");
    expect(unquoteGitPath("plain.txt")).toBe("plain.txt");
    expect(unquoteGitPath('"tab\\there"')).toBe("tab\there");
  });
});
