import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run, type Deps, type RunEnv } from "../src/main.js";
import type { ActionInputs } from "../src/inputs.js";
import { ReadonlyTokenError } from "../src/github.js";
import type { ReviewPayload } from "../src/review.js";
import type { Finding } from "../src/fastpath.js";

const SHA_HEAD = "a".repeat(40);
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

const LLM_FINDING: Finding = {
  severity: "warning",
  file: "src/a.ts",
  line: 2,
  rule: "logic",
  message: "llm message",
};

interface MockOpts {
  llmApiKey?: string;
  prBody?: string;
  forkReadonly?: boolean;
  postComment?: boolean;
  binaryOnly?: boolean;
  prNumber?: number | null;
  validateModel?: boolean | "reject";
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
    failLevel: "warning",
    maxDiffChars: 60000,
    postComment: o.postComment ?? true,
    timeoutSeconds: 90,
    prNumber: o.prNumber === undefined ? 7 : o.prNumber,
  };
}

function scratch(): string {
  mkdirSync("/tmp/opencode", { recursive: true });
  return mkdtempSync("/tmp/opencode/pr-main-");
}

async function runWithMocks(o: MockOpts = {}) {
  const root = scratch();
  const artifactDir = join(root, "out");
  mkdirSync(artifactDir);
  writeFileSync(join(artifactDir, "diff.patch"), o.binaryOnly ? BINARY : DIFF);
  const summaryPath = join(root, "summary.md");
  writeFileSync(summaryPath, "");

  const state = {
    issueBodyFetched: undefined as number | undefined,
    payloads: [] as ReviewPayload[],
    llmCalled: 0,
    ollamaCalled: 0,
  };

  const env: RunEnv = {
    eventName: o.prNumber === null ? "workflow_dispatch" : "pull_request",
    payload: o.prNumber === null ? {} : { action: "synchronize", pull_request: { number: 7 } },
    inputs: inputsFor(o),
    workDir: root,
    artifactDir,
    baseSha: SHA_BASE,
    headSha: SHA_HEAD,
    tokenIsApp: false,
    issueFallback: false,
    hasSemgrepToken: false,
    summaryPath,
  };

  const deps: Deps = {
    gh: {
      getPr: async () => ({
        body: o.prBody ?? "",
        headSha: SHA_HEAD,
        headRepo: o.forkReadonly ? "fork/r" : "o/r",
        isFork: o.forkReadonly === true,
      }),
      getIssueBody: async (n) => {
        state.issueBodyFetched = n;
        return "issue text";
      },
      createReview: async (_pr, payload, opts) => {
        if (!opts.canWrite) throw new ReadonlyTokenError("refused", 403, "resource not accessible");
        state.payloads.push(payload);
      },
      createIssueComment: async () => {},
    },
    analysis: {
      runScanners: async () => ({ findings: [] }),
      runL2: async () => [],
      ensureOllama: async () => {
        state.ollamaCalled += 1;
      },
      validateModelExists: async () => {
        if (o.validateModel === "reject") throw new Error("GET /models failed with HTTP 500");
        return o.validateModel !== false;
      },
      callLlm: async () => {
        state.llmCalled += 1;
        return { ok: true, findings: [LLM_FINDING] };
      },
    },
  };

  const out = await run(env, deps);
  return {
    ...out,
    issueBodyFetched: state.issueBodyFetched,
    body: state.payloads.at(-1)?.body,
    llmCalled: state.llmCalled,
    artifactDir,
    summaryPath,
  };
}

function spyFail(name: string): () => never {
  return () => {
    throw new Error(`${name} must not be invoked in the privileged flow`);
  };
}

async function runPrivilegedWithSpies() {
  const root = scratch();
  const artifactDir = join(root, "priv");
  mkdirSync(artifactDir);
  writeFileSync(
    join(artifactDir, "pr-meta.json"),
    JSON.stringify({
      pr_number: 7,
      head_sha: SHA_HEAD,
      base_sha: SHA_BASE,
      head_repo_full_name: "o/r",
      is_fork: false,
    }),
  );
  writeFileSync(join(artifactDir, "findings.json"), JSON.stringify([LLM_FINDING]));
  writeFileSync(join(artifactDir, "diff.patch"), DIFF);
  const payloads: ReviewPayload[] = [];
  const env: RunEnv = {
    eventName: "workflow_run",
    payload: { workflow_run: { head_sha: SHA_HEAD, event: "pull_request", conclusion: "success" } },
    inputs: inputsFor({}),
    workDir: root,
    artifactDir,
    baseSha: SHA_BASE,
    headSha: SHA_HEAD,
    tokenIsApp: false,
    issueFallback: false,
    hasSemgrepToken: false,
  };
  const deps: Deps = {
    gh: {
      getPr: async () => ({ body: "", headSha: SHA_HEAD, headRepo: "o/r", isFork: false }),
      getIssueBody: async () => "",
      createReview: async (_pr, payload) => {
        payloads.push(payload);
      },
      createIssueComment: async () => {},
    },
    analysis: {
      runScanners: spyFail("scanners"),
      runL2: spyFail("l2"),
      ensureOllama: spyFail("ollama"),
      validateModelExists: spyFail("models"),
      callLlm: spyFail("llm"),
    },
  };
  const out = await run(env, deps);
  return { ...out, payloads };
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
    expect(readFileSync(join(r.artifactDir, "diff.patch"), "utf8")).toContain("src/a.ts");
    expect(readFileSync(join(r.artifactDir, "pr-meta.json"), "utf8")).toContain('"is_fork": true');
  });

  it("privileged flow never calls checkout/scanners/llm", async () => {
    const calls = await runPrivilegedWithSpies(); // spies throw if scanners/l2/ollama/llm invoked
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
    const posted: ReviewPayload[] = [];
    const env: RunEnv = {
      eventName: "workflow_run",
      payload: {},
      inputs: inputsFor({}),
      workDir: root,
      artifactDir,
      baseSha: SHA_BASE,
      headSha: SHA_HEAD,
      tokenIsApp: true,
      issueFallback: false,
      hasSemgrepToken: false,
    };
    const deps: Deps = {
      gh: {
        getPr: async () => ({ body: "", headSha: SHA_HEAD, headRepo: "o/r", isFork: false }),
        getIssueBody: async () => "",
        createReview: async (_pr, payload) => {
          posted.push(payload);
        },
        createIssueComment: async () => {},
      },
      analysis: {
        runScanners: spyFail("scanners"),
        runL2: spyFail("l2"),
        ensureOllama: spyFail("ollama"),
        validateModelExists: spyFail("models"),
        callLlm: spyFail("llm"),
      },
    };
    await expect(run(env, deps)).rejects.toThrow(/pr-meta\.json/);
    expect(posted).toHaveLength(0);
  });
});
