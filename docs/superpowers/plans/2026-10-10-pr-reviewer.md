# PR Reviewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the v1 reusable TypeScript GitHub Action that posts hybrid fast-path + BYOK LLM reviews on PRs.

**Architecture:** Single JS action (`action.yml` → `dist/index.js`, Node 24). `main.ts` orchestrates Fluxo A (unprivileged: diff → fast-path → slow-path → review POST) and Fluxo B (privileged `workflow_run`: download artifact → validate → POST). Provider layer defaults to `POST {base}/chat/completions` with a versioned `(provider,model)->api_style` map and fail-fast for non-chat pairs.

**Tech Stack:** TypeScript 5.x, Node >=24 (`@tsconfig/node24`, `@types/node ^24`), `@actions/core`, `@actions/github`, `esbuild` (bundle to `dist/`), `vitest` (unit), committed `dist/`.

**Spec:** `docs/superpowers/specs/2026-10-10-pr-reviewer-design.md`

## Global Constraints

- `action.yml` uses `runs.using: node24`, `main: dist/index.js`; `dist/` is committed; `engines.node >=24`.
- Third-party actions pinned by SHA; `persist-credentials: false`; never interpolate PR title/body into `run:`.
- `temperature`/`top_p`/`n` NEVER sent by default; only via explicit `llm_temperature`/`llm_top_p` with family validation (reasoning GPT-5+/6 + Claude 4.7+ reject non-default).
- `response_format` uses full shape `{"type":"json_schema","json_schema":{"name":"pr_review","schema":{...},"strict":true}}` only where supported; omitted for Anthropic-compat (assert ignored, not 400).
- Reasoning models (`o-series`/`gpt-5*`/`gpt-6*`) get `max_completion_tokens`, all others `max_tokens`; never both.
- `side` computed from hunk (`-` → `LEFT`, else `RIGHT`); `start_line+start_side` always paired in multi-line; `position` never written.
- Contract everywhere: `{severity: info|warning|high, file, line?, rule, message, suggestion?}`.
- Privileged job never checks out fork head, never re-runs scanners; reuses artifact.
- `llm_api_key` never logged (redact in errors); diff is untrusted data inside XML delimiters.

## Review Focus

- Diff with renamed files (`rename from/to`) — findings must follow the new path, not the old one.
- `head_sha` changes between resolve and POST (push mid-run) — expect re-resolve once, then degrade offending comments to general body items.
- Provider returns 200 with `content` that is JSON wrapped in markdown fences — expect fence-stripping before validation, not a hard failure.
- `issue_comment` on an issue (not a PR) containing `/review` — expect no-op with log, no crash, no POST.
- Binary-only PR (no text hunks) — expect fast-path binary note + skip slow-path with warning, exit 0.

---

### Task 1: Scaffolding + git init

**Files:**
- Create: `package.json`, `tsconfig.json`, `action.yml`, `src/main.ts`, `.gitignore`
- Test: `tests/smoke.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `src/main.ts` exporting `async function run(): Promise<void>` (entry; later tasks fill stages)

- [ ] **Step 1: Write the failing test**

```ts
// tests/smoke.test.ts
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
describe("scaffolding", () => {
  it("action.yml targets node24 dist and declares all consumed inputs", () => {
    const yml = fs.readFileSync("action.yml", "utf8");
    expect(yml).toContain("using: node24");
    expect(yml).toContain("main: dist/index.js");
    for (const s of ["github_token", "llm_provider", "llm_base_url", "llm_api_style", "llm_path", "llm_model", "llm_api_key", "llm_temperature", "llm_top_p", "pr_number", "fail_level", "max_diff_chars", "post_comment", "timeout_seconds", "llm_max_tokens"]) expect(yml).toContain(s);
  });
  it("package requires node24 and pins researched versions", () => {
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    expect(pkg.engines.node).toMatch(/24/);
    expect(pkg.dependencies["@actions/core"]).toBe("3.0.1");
    expect(pkg.dependencies["@actions/github"]).toBe("9.1.1");
    expect(pkg.devDependencies["typescript"]).toBe("5.9.3");
    expect(pkg.devDependencies["vitest"]).toBe("5.0.3");
    expect(pkg.devDependencies["esbuild"]).toBe("0.28.2");
    const gi = fs.readFileSync(".gitignore", "utf8");
    expect(gi).not.toMatch(/^dist\/?$/m);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/smoke.test.ts`
Expected: FAIL (files do not exist)

- [ ] **Step 3: Implement scaffolding**

Create `package.json` (type module, engines.node >=24, exact pinned deps researched 2026-10-10 — typescript `5.9.3` NOT v7: TS 7 native port is an ecosystem-compat risk for actions tooling; deps `@actions/core 3.0.1` `@actions/github 9.1.1`, dev `vitest 5.0.3` `esbuild 0.28.2` `@tsconfig/node24 24.0.5` `@types/node 26.6.5`), `tsconfig.json` (extends `@tsconfig/node24`, outDir `lib`, strict), `action.yml` (name, description, all inputs from spec §3.1 with defaults: `github_token`, `llm_provider openai`, `llm_base_url ""`, `llm_api_style auto`, `llm_path ""`, `llm_model ""`, `llm_api_key ""`, `llm_temperature ""`, `llm_top_p ""`, `pr_number ""` (workflow_dispatch only), `fail_level warning`, `max_diff_chars 60000`, `post_comment true`, `timeout_seconds 90`, `llm_max_tokens 2000`; `runs.using: node24`, `main: dist/index.js`), `src/main.ts` with stub `export async function run(): Promise<void> {}` + `run()` invocation guard, `.gitignore` (node_modules, lib; `dist/` NOT ignored). Run `git init` if no `.git`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/smoke.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json action.yml src/main.ts .gitignore tests/smoke.test.ts
git commit -m "chore: scaffold TS node24 action"
```

### Task 2: Input parsing + validation

**Files:**
- Create: `src/inputs.ts`
- Test: `tests/inputs.test.ts`

**Interfaces:**
- Consumes: `@actions/core.getInput`
- Produces: `export type FailLevel = "none"|"warning"|"high"` + `export function parseFailLevel(v: string): FailLevel` (throws on invalid) + `export interface ActionInputs { githubToken, llmProvider, llmBaseUrl, llmApiStyle, llmPath, llmModel, llmApiKey, llmTemperature?, llmTopP?, llmMaxTokens, failLevel: FailLevel, maxDiffChars, postComment, timeoutSeconds, prNumber: number | null }` + `export function getInputs(): ActionInputs` (`pr_number` parsed only when non-empty, else null)

- [ ] **Step 1: Write the failing test**

```ts
import { getInputs, parseFailLevel } from "../src/inputs.js";
it("defaults match spec", () => {
  const i = getInputs(); // with empty env
  expect(i.llmProvider).toBe("openai");
  expect(i.llmApiStyle).toBe("auto");
  expect(i.failLevel).toBe("warning");
  expect(i.maxDiffChars).toBe(60000);
  expect(i.timeoutSeconds).toBe(90);
  expect(i.llmMaxTokens).toBe(2000);
  expect(i.llmTemperature).toBeUndefined();
  expect(i.llmTopP).toBeUndefined();
});
it("rejects bad fail_level; pr_number defaults null", () => {
  expect(() => parseFailLevel("block")).toThrow(/fail_level/);
  expect(getInputs().prNumber).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/inputs.test.ts`
Expected: FAIL with "Cannot find module '../src/inputs.js'"

- [ ] **Step 3: Implement `getInputs()` + `parseFailLevel()` in `src/inputs.ts`**

Read via `core.getInput`, coerce ints/bools, validate `llm_provider` in 10-value set, `llm_api_style` in 6-value set. `llm_temperature`/`llm_top_p` parsed only when non-empty (family validation lives in `validateSampling`, Task 9). Throw on invalid with message naming the input.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/inputs.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/inputs.ts tests/inputs.test.ts
git commit -m "feat: parse and validate action inputs"
```

### Task 3: Provider presets + NON_CHAT map + auto resolution + model-existence check

**Files:**
- Create: `src/providers.ts`
- Test: `tests/providers.test.ts`

**Interfaces:**
- Consumes: `ActionInputs` fields
- Produces: `export class UnsupportedModelError extends Error {}` + `export type ApiStyle = "auto"|"openai-chat"|"openai-responses"|"anthropic-messages"|"google-models"|"custom-path"` + `export const NON_CHAT: ReadonlyMap<string, Exclude<ApiStyle, "auto"|"openai-chat"|"custom-path">>` keyed `provider:model` (ONLY non-chat pairs: e.g. `opencode-go:qwen3.8-max`→messages, `opencode-go:minimax-m3`→messages, `opencode-zen:claude-sonnet-5-5`→messages, `opencode-zen:gpt-6-luna`→responses, `opencode-zen:gemini-3.8-flash`→google-models, `opencode-zen:gemini-3.5-flash-lite`→google-models; chat-supported pairs like `opencode-zen:qwen3.8-max` are NOT in the map; `llm_path` alone never enables a body adapter — `custom-path` without a v2 style throws the path-only error) + `export interface ResolvedEndpoint { baseUrl, path, headers: Record<string,string> }` (baseUrl WITHOUT path) + `export function resolveEndpoint(o: { llmProvider, llmBaseUrl, llmApiStyle, llmPath, llmModel, llmApiKey, prNumber: number | null }): ResolvedEndpoint` (throws `UnsupportedModelError` for non-chat pairs or explicit v2 styles; `x-opencode-session: pr-<n>` only when provider is opencode-go AND prNumber non-null, else header omitted) + `export async function validateModelExists(baseUrl: string, model: string, apiKey: string): Promise<boolean>` (GET `{base}/models`, checks id presence only — existence, never endpoint routing)

- [ ] **Step 1: Write the failing test**

```ts
import { resolveEndpoint, UnsupportedModelError, validateModelExists, NON_CHAT } from "../src/providers.js";
const base = { llmBaseUrl: "", llmApiStyle: "auto", llmPath: "", llmApiKey: "k", prNumber: 1 } as const;
it("base and path are separate for zen", () => {
  const r = resolveEndpoint({ ...base, llmProvider: "opencode-zen", llmModel: "glm-5.3-flash" });
  expect(r.baseUrl).toBe("https://opencode.ai/zen/v1");
  expect(r.path).toBe("/chat/completions");
});
it("zen qwen3.8-max resolves chat, go qwen3.8-max throws", () => {
  expect(resolveEndpoint({ ...base, llmProvider: "opencode-zen", llmModel: "qwen3.8-max" }).path).toBe("/chat/completions");
  expect(() => resolveEndpoint({ ...base, llmProvider: "opencode-go", llmModel: "qwen3.8-max" })).toThrow(UnsupportedModelError);
});
it("zen sends no session header, go does", () => {
  const z = resolveEndpoint({ ...base, llmProvider: "opencode-zen", llmModel: "deepseek-v4.1-flash" });
  expect(z.headers["User-Agent"]).toContain("pr-reviewer");
  expect(z.headers["x-opencode-session"]).toBeUndefined();
  const g = resolveEndpoint({ ...base, llmProvider: "opencode-go", llmModel: "glm-5.3-flash" });
  expect(g.headers["x-opencode-session"]).toBe("pr-1");
});
it("matrix: documented chat models resolve, non-chat fail-fast", () => {
  for (const m of ["deepseek-v4.1-flash","deepseek-v4-pro","deepseek-v4-flash","glm-5.3-flash","glm-5.3","glm-5.2","kimi-k3","kimi-k2.7-code","kimi-k2.6","minimax-m3","minimax-m2.7","mistral-large-4","qwen3.8-max","big-pickle","space-bunny-free","mimo-v2.6-flash-free"]) {
    expect(resolveEndpoint({ ...base, llmProvider: "opencode-zen", llmModel: m }).path).toBe("/chat/completions");
  }
  expect(() => resolveEndpoint({ ...base, llmProvider: "opencode-zen", llmModel: "gpt-6-luna" })).toThrow(UnsupportedModelError);
  expect(() => resolveEndpoint({ ...base, llmProvider: "opencode-zen", llmModel: "claude-sonnet-5-5" })).toThrow(UnsupportedModelError);
});
it("zen non-chat fail-fast covers v2 list", () => {
  for (const m of ["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra", "grok-4.7", "grok-4.6", "claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "qwen3.7-max", "qwen3.7-plus", "gemini-3.8-flash", "gemini-3.5-flash-lite"]) {
    expect(() => resolveEndpoint({ ...base, llmProvider: "opencode-zen", llmModel: m })).toThrow(UnsupportedModelError);
  }
});
it("go chat models resolve, go non-chat fail-fast", () => {
  for (const m of ["glm-5.3-flash", "glm-5.3", "glm-5.2", "kimi-k3", "kimi-k2.7-code", "kimi-k2.6", "deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4.1-flash", "deepseek-v4-flash-vision-exp", "mimo-v2.6-flash", "mimo-v2.5", "mimo-v2.6-pro", "hy4-preview", "hy3", "longcat-2.0", "space-bunny"]) {
    expect(resolveEndpoint({ ...base, llmProvider: "opencode-go", llmModel: m }).path).toBe("/chat/completions");
  }
  for (const m of ["grok-4.7", "grok-4.6", "gpt-6-luna", "gpt-5.6-luna", "gpt-6.1-sol", "gpt-6-astra", "muse-spark-1.3-contributor", "claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "minimax-m3", "minimax-m2.7", "qwen3.8-max", "qwen3.8-flash", "qwen3.7-max", "qwen3.7-plus", "gemini-3.8-flash", "gemini-3.5-flash-lite"]) {
    expect(() => resolveEndpoint({ ...base, llmProvider: "opencode-go", llmModel: m })).toThrow(UnsupportedModelError);
  }
});
it("llm_path to non-chat without v2 style throws path-only error", () => {
  expect(() => resolveEndpoint({ ...base, llmProvider: "custom", llmBaseUrl: "https://x", llmModel: "m", llmPath: "/messages" })).toThrow(/path-only/);
});
it("explicit v2 api_style throws in v1", () => {
  expect(() => resolveEndpoint({ ...base, llmProvider: "openai", llmModel: "m", llmApiStyle: "anthropic-messages" })).toThrow(UnsupportedModelError);
});
it("prNumber null ok, go without number omits session header", () => {
  expect(resolveEndpoint({ ...base, llmProvider: "openai", llmModel: "m", prNumber: null }).headers["x-opencode-session"]).toBeUndefined();
  expect(resolveEndpoint({ ...base, llmProvider: "opencode-go", llmModel: "glm-5.3-flash", prNumber: null }).headers["x-opencode-session"]).toBeUndefined();
  const g = resolveEndpoint({ ...base, llmProvider: "opencode-go", llmModel: "glm-5.3-flash" });
  expect(g.headers["x-opencode-session"]).toBe("pr-1");
});
it("validateModelExists checks id presence only", async () => {
  expect(await validateModelExists("https://x", "m", "k")).toBe(true); // mocked GET list containing m
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/providers.test.ts`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement `src/providers.ts`**

Preset table (baseUrl only, no path baked in): openai `https://api.openai.com/v1`, anthropic `https://api.anthropic.com/v1`, google `https://generativelanguage.googleapis.com/v1beta/openai`, groq `https://api.groq.com/openai/v1`, mistral `https://api.mistral.ai/v1`, openrouter `https://openrouter.ai/api/v1`, ollama `http://localhost:11434/v1`, `opencode-zen https://opencode.ai/zen/v1`, `opencode-go https://opencode.ai/zen/go/v1`, custom requires `llm_base_url`. `auto` = openai-chat unless `(provider:model)` in NON_CHAT → throw with supported list. Explicit non-chat `llm_api_style` in v1 throws (v2 only). `llm_path` overrides path only; if it names `/messages|/responses|/models` without a v2 style → throw path-only error. Headers: `Authorization: Bearer <key>`, `User-Agent: pr-reviewer/1.0`, plus `x-opencode-session: pr-<n>` for opencode-go ONLY. Document Go per-model limits (5h 20%, week 50%, month 100%, caps $15–60) + Zen-balance fallback in code comment. `validateModelExists` fetches `{base}/models` and checks id presence; never infers endpoint.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/providers.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/providers.ts tests/providers.test.ts
git commit -m "feat: provider presets and chat-only auto resolution"
```

### Task 4: Diff generation, filtering, truncation, pr-meta

**Files:**
- Create: `src/diff.ts`
- Test: `tests/diff.test.ts`

**Interfaces:**
- Consumes: `baseSha, headSha, maxDiffChars, perFileCap=8000`
- Produces: `export interface FileDiff { file, hunks: string, truncated: boolean, binary?: boolean, size?: number }` (size = bytes on disk via stat; `large-file` rule uses `size`, never `hunks.length`) + `export function filterForPrompt(files: FileDiff[]): FileDiff[]` (PROMPT-LLM ONLY: drops lockfiles (`package-lock.json` class), `*.min.js`, `*.map`, AND entries with `binary===true` — returns the FileDiff objects (hunks preserved for `truncateDiff`/`buildMessages`); decision uses `f.binary`, never extension guessing; `run()` MUST call `runL0` on the UNFILTERED file list first — binaries/lockfiles feed `binary note`/`lockfile-without-manifest` — then `filterForPrompt` only for the LLM prompt) + `export function parseRename(nameStatus: string): { oldPath: string, newPath: string }[]` (parses `git diff --name-status -R` `R100 old new` lines and `rename from/to` headers; findings always use newPath) + `export function truncateDiff(files: FileDiff[], maxChars: number, perFile: number): { text: string, skipped: string[] }` + `export interface PrMeta { pr_number: number, head_sha: string, base_sha: string, head_repo_full_name: string, is_fork: boolean }` + `export function writePrMeta(m: PrMeta, dir: string): void` / `readPrMeta`

- [ ] **Step 1: Write the failing test**

```ts
import { filterForPrompt, truncateDiff, parseRename } from "../src/diff.js";
// Fixture local (define hunksFor(file) no topo de tests/diff.test.ts retornando
// ParsedHunk[] mínimo; NÃO importar de review.js — Task 4 implementa só diff.ts)
it("prompt filter drops lock/minified/map/binaries from prompt (L0 runs unfiltered)", () => {
  const F = (file: string, binary = false) => ({ file, hunks: "", truncated: false, binary });
  expect(filterForPrompt([F("src/a.ts"), F("package-lock.json"), F("dist/b.min.js"), F("a.map")]).map((f) => f.file)).toEqual(["src/a.ts"]);
  expect(filterForPrompt([F("img.png", true), F("package-lock.json")])).toEqual([]);
  const { text } = truncateDiff([{ file: "big.ts", hunks: "x".repeat(20000), truncated: false }], 60000, 8000);
  expect(text.length).toBeLessThanOrEqual(8000);
});
it("follows renames via parseRename (new path), both formats", () => {
  const r = parseRename("R100\told/a.ts\tnew/a.ts\nM\tsrc/b.ts");
  expect(r).toEqual([{ oldPath: "old/a.ts", newPath: "new/a.ts" }]);
  const h = parseRename("rename from old/c.ts\nrename to new/c.ts\n");
  expect(h).toEqual([{ oldPath: "old/c.ts", newPath: "new/c.ts" }]);
  expect(hunksFor("new/a.ts")[0].file).toBe("new/a.ts");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/diff.test.ts`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement `src/diff.ts`**

`filterForPrompt` drops lockfiles (`package-lock.json` class), `*.min.js`, `*.map` — PROMPT ONLY. `run()` MUST call `runL0` on the UNFILTERED file list first (binaries + lockfiles feed `binary note` and `lockfile-without-manifest`), then filter for the LLM prompt. `truncateDiff` caps per file at `perFile` + global `maxChars`, records skipped files with note. Rename handling: callers pass the new path.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/diff.test.ts`
Expected: PASS (also pins Review Focus: renamed files follow new path)

- [ ] **Step 5: Commit**

```bash
git add src/diff.ts tests/diff.test.ts
git commit -m "feat: diff filter truncate and pr-meta"
```

### Task 5: Fast-path L0 (agnostic)

**Files:**
- Create: `src/fastpath.ts`
- Test: `tests/fastpath.test.ts`

**Interfaces:**
- Consumes: `FileDiff[]`
- Produces: `export interface Finding { severity: "info"|"warning"|"high", file: string, line?: number, rule: string, message: string, suggestion?: string }` + `export function runL0(files: FileDiff[], o?: { hasManifestFor?: (lockfile: string) => boolean }): Finding[]` (`lockfile-without-manifest` fires per-ecosystem: `package-lock.json` needs `package.json`, `Cargo.lock` needs `Cargo.toml`, etc. — a global `dirHasManifest:true` must NOT suppress an unrelated ecosystem; callers pass per-lockfile lookup)

- [ ] **Step 1: Write the failing test**

```ts
import { runL0 } from "../src/fastpath.js";
it("flags pem, todos, lockfile-without-manifest (per-ecosystem)", () => {
  const noManifest = () => false;
  const f = runL0(
    [
      { file: "id_rsa", hunks: "key", truncated: false },
      { file: "a.ts", hunks: "// TODO fix", truncated: false },
      { file: "package-lock.json", hunks: "{}", truncated: false },
    ],
    { hasManifestFor: noManifest },
  );
  expect(f.some((x) => x.rule === "sensitive-path" && x.severity === "high")).toBe(true);
  expect(f.some((x) => x.rule === "todo-marker")).toBe(true);
  expect(f.some((x) => x.rule === "lockfile-without-manifest")).toBe(true);
  const mixed = runL0([{ file: "Cargo.lock", hunks: "", truncated: false }], {
    hasManifestFor: (l) => l === "package-lock.json",
  });
  expect(mixed.some((x) => x.rule === "lockfile-without-manifest")).toBe(true);
  const ok = runL0([{ file: "package-lock.json", hunks: "{}", truncated: false }], { hasManifestFor: () => true });
  expect(ok.some((x) => x.rule === "lockfile-without-manifest")).toBe(false);
});
it("binary-only input yields binary note (size-based) and large file warns", () => {
  const f = runL0([{ file: "img.png", hunks: "", truncated: false, size: 1024 }]);
  expect(f.some((x) => x.rule === "binary-note")).toBe(true);
  const big = runL0([{ file: "vid.mp4", hunks: "", truncated: false, size: 600 * 1024 }]);
  expect(big.some((x) => x.rule === "large-file" && x.severity === "warning")).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/fastpath.test.ts`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement `runL0` in `src/fastpath.ts`**

Rules: sensitive paths (high), files >500KB (warning), TODO/FIXME/XXX (info with line), lockfile-without-manifest (warning), binary note (info). Regex secrets kept minimal (gitleaks owns depth in Task 6).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/fastpath.test.ts`
Expected: PASS (pins Review Focus: binary-only PR)

- [ ] **Step 5: Commit**

```bash
git add src/fastpath.ts tests/fastpath.test.ts
git commit -m "feat: fast-path L0 agnostic checks"
```

### Task 6: Scanners L1 (semgrep/trivy/gitleaks/osv/SBOM) + SARIF conditional

**Files:**
- Create: `src/scanners.ts`
- Test: `tests/scanners.test.ts`

**Interfaces:**
- Consumes: repo dir, `{ baselineSha, jobs: number, hasSemgrepToken: boolean }`
- Produces: `export const SEMGREP_VERSION = "1.180.0"` (pin CI install: `pip install semgrep==1.180.0`; semgrep runs from PyPI binary, never the npm `semgrep` stub) + `export const TRIVY_IMAGE = "ghcr.io/aquasecurity/trivy:0.75.0"` + `export const TRIVY_DIGEST = "sha256:af6acf9a6b85dfe389a1941505c0ce9efef52a4719635e1a962f022a3d855daa"` (pin by digest: ghcr multi-arch index, resolved 2026-10-10 — v0.75.0 safe line after CVE-2026-33634 compromise of v0.69.4 + trivy-action/setup-trivy tags; NEVER use trivy-action/setup-trivy or Docker Hub tag without digest) + `export const OSV_VERSION = "v2.6.0"` + `export const OSV_DIGEST = "sha256:afd838850ac1a0fcc15ff4a041dc9ba11123c3f0d2666217a5f0fcf9222b55fa"` (`ghcr.io/google/osv-scanner:v2.6.0@sha256:<digest>`, multi-arch index resolved 2026-10-10) + `export function resolveJobs(): number` (`Math.max(1, os.availableParallelism?.() ?? os.cpus().length)`) + `export function semgrepArgv(o: { baselineSha: string, jobs: number, hasToken: boolean }): { argv: string[], env: { SEMGREP_BASELINE_COMMIT?: string } }` (token → `{argv:["ci","--metrics=off",...], env:{SEMGREP_BASELINE_COMMIT:<merge-base>}}`; no token → `{argv:["scan","--config","auto","--metrics=off","--jobs",String(n),"--baseline-commit",sha], env:{}}`) + `export const GITLEAKS_IMAGE = "ghcr.io/gitleaks/gitleaks:v8.30.1"` + `export const GITLEAKS_DIGEST = "sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f"` (pin by digest: multi-arch index resolved 2026-10-10, latest stable) + `export function gitleaksArgv(dir: string): string[]` (`["dir",dir,"--report-format","sarif"]` — subcomando `detect` deprecated desde gitleaks v8.19; missing binary → warning finding) + `export function sbomArgv(target: string): string[]` (`["fs","--format","cyclonedx",target]` — geração via scan; o subcomando `sbom` do Trivy recebe um SBOM como INPUT, e o format name é `cyclonedx`, não `cyclonedx-json`), pinned same TRIVY image+digest) — SBOM optional flag `sbom: boolean` in `runScanners` opts + `export function trivyArgv(target: string): string[]` (always `["fs","--format","sarif","--severity","HIGH,CRITICAL",target]`, pinned `aquasecurity/trivy:0.75.0`) + `export function osvArgv(lockfile: string): string[]` (v2 CLI: always `["scan","-L",lockfile,"--format","sarif"]` — v1 `scan source --lockfile=` does NOT exist in v2; pinned `osv-scanner:v2.6.0`) + `export function isSameRepo(event: string, payload: { pullHeadRepo?: string }, prMeta?: PrMeta, repo?: string): boolean` + `export function shouldUploadSarif(o: { isSameRepo: boolean, hasPermission: boolean, codeScanningEnabled: boolean }): boolean` + `export async function runScanners(o: { dir: string, baselineSha: string }): Promise<Finding[]>` (missing binary → warning finding, never throw; SARIF upload `continue-on-error` → artifact fallback)

- [ ] **Step 1: Write the failing test**

```ts
import { semgrepArgv, shouldUploadSarif, isSameRepo, resolveJobs, gitleaksArgv, trivyArgv, sbomArgv, osvArgv, TRIVY_IMAGE, TRIVY_DIGEST, OSV_VERSION, OSV_DIGEST, GITLEAKS_IMAGE, GITLEAKS_DIGEST } from "../src/scanners.js";
it("no-token argv uses scan+baseline-commit and no env", () => {
  const r = semgrepArgv({ baselineSha: "abc", jobs: 4, hasToken: false });
  expect(r.argv).toEqual(["scan","--config","auto","--metrics=off","--jobs","4","--baseline-commit","abc"]);
  expect(r.env.SEMGREP_BASELINE_COMMIT).toBeUndefined();
});
it("token argv uses ci with baseline env, exact shape", () => {
  const r = semgrepArgv({ baselineSha: "abc", jobs: 4, hasToken: true });
  expect(r.argv).toEqual(["ci", "--metrics=off", "--jobs", "4"]);
  expect(r.env.SEMGREP_BASELINE_COMMIT).toBeDefined();
});
it("sbom argv generates cyclonedx via fs scan", () => {
  expect(sbomArgv(".")).toEqual(["fs", "--format", "cyclonedx", "."]);
});
it("gitleaks argv uses dir with sarif report format (detect deprecated)", () => {
  expect(gitleaksArgv(".")).toEqual(["dir", ".", "--report-format", "sarif"]);
  expect(GITLEAKS_IMAGE).toContain("8.30.1");
  expect(GITLEAKS_DIGEST).toMatch(/^sha256:[0-9a-f]{64}$/);
});
it("trivy and osv argv use exact scanner format", () => {
  expect(trivyArgv(".")).toEqual(["fs", "--format", "sarif", "--severity", "HIGH,CRITICAL", "."]);
  expect(osvArgv("package-lock.json")).toEqual(["scan", "-L", "package-lock.json", "--format", "sarif"]);
});
it("sarif gated on same-repo + permission + flag; both events covered", () => {
  expect(shouldUploadSarif({ isSameRepo: true, hasPermission: true, codeScanningEnabled: true })).toBe(true);
  expect(shouldUploadSarif({ isSameRepo: false, hasPermission: true, codeScanningEnabled: true })).toBe(false);
  expect(isSameRepo("pull_request", { pullHeadRepo: "o/r" }, undefined, "o/r")).toBe(true);
  expect(isSameRepo("pull_request", { pullHeadRepo: "f/r" }, undefined, "o/r")).toBe(false);
  expect(isSameRepo("workflow_run", {}, { head_repo_full_name: "o/r" } as never, "o/r")).toBe(true);
  expect(isSameRepo("workflow_run", {}, { head_repo_full_name: "f/r" } as never, "o/r")).toBe(false);
});
it("jobs resolves to a positive int and pins are exported", () => {
  expect(resolveJobs()).toBeGreaterThan(0);
  expect(TRIVY_IMAGE).toContain("0.75.0");
  expect(TRIVY_DIGEST).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(OSV_VERSION).toContain("2.6.0");
  expect(OSV_DIGEST).toMatch(/^sha256:[0-9a-f]{64}$/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/scanners.test.ts`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement `src/scanners.ts`**

Token branch sets `SEMGREP_BASELINE_COMMIT=$(git merge-base…)` env (REF is superseded); never claim `ci` diff-aware without token. Trivy pinned `ghcr.io/aquasecurity/trivy:0.75.0` scans target (`fs --format sarif --severity HIGH,CRITICAL`); SBOM generation via `trivy fs --format cyclonedx` (same `sbomArgv`; the `sbom` subcommand consumes SBOM input, never generates); OSV-Scanner pinned `ghcr.io/google/osv-scanner:v2.6.0` scans lockfiles (`scan -L <f> --format sarif`, v2 CLI). SARIF same-repo guard per event (pull_request event path vs pr-meta artifact path for workflow_run).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/scanners.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/scanners.ts tests/scanners.test.ts
git commit -m "feat: L1 scanners and gated SARIF"
```

### Task 7: L2 native detectors (config-presence only)

**Files:**
- Create: `src/l2.ts`
- Test: `tests/l2.test.ts`

**Interfaces:**
- Consumes: repo dir
- Produces: `export interface L2Tool { name: string, cmd: string, args: string[] }` + `export function detectL2Tools(dir: string): string[]` (names subset of `["cargo-fmt","cargo-clippy","prettier","eslint","ruff","gofmt","go vet"]`; markers: `Cargo.toml`→both cargo tools, `package.json` OR `.prettierrc*`/`prettier.config.*`→prettier (config may live in package.json alone), `.eslintrc*`/`eslint.config.*`→eslint, `ruff.toml` OR `pyproject.toml` containing `[tool.ruff]` (read file — bare pyproject does NOT trigger)→ruff, `go.mod`→`gofmt`+`go vet`) + `export function l2Argv(name: string): { cmd: string, args: string[] }` (check-only pins: `"cargo-fmt"`→`{cargo,["fmt","--check"]}`, `"cargo-clippy"`→`{cargo,["clippy","--","-D","warnings"]}`, `"prettier"`→`{prettier,["--check","."]}`, `"eslint"`→`{eslint,["."]}`, `"ruff"`→`{ruff,["check","."]}`, `"gofmt"`→`{gofmt,["-l","."]}`, `"go vet"`→`{cmd:"go",args:["vet","./..."]}`; never mutating form, never `execFile("go vet")`) + `export async function runL2(dir: string): Promise<Finding[]>`

**Test fixtures:** create `tests/fixtures/rust-node/` (`Cargo.toml`, `package.json` + `.prettierrc` + `.eslintrc.json`), `tests/fixtures/empty/`, `tests/fixtures/go/` (`go.mod`), `tests/fixtures/python/` (`ruff.toml`), and `tests/fixtures/gofmt/` (`go.mod`) in this task.

- [ ] **Step 1: Write the failing test**

```ts
import { detectL2Tools, l2Argv } from "../src/l2.js";
it("detects cargo pair and prettier by markers", () => {
  expect(detectL2Tools("tests/fixtures/rust-node")).toEqual(expect.arrayContaining(["cargo-fmt","cargo-clippy","prettier"]));
  expect(detectL2Tools("tests/fixtures/empty")).toEqual([]);
});
it("detects eslint/ruff markers too", () => {
  expect(detectL2Tools("tests/fixtures/rust-node")).toEqual(expect.arrayContaining(["eslint"]));
  expect(detectL2Tools("tests/fixtures/python")).toEqual(expect.arrayContaining(["ruff"]));
  expect(detectL2Tools("tests/fixtures/gofmt")).toEqual(expect.arrayContaining(["gofmt"]));
});
it("detects gofmt+go vet by go.mod and splits argv", () => {
  expect(detectL2Tools("tests/fixtures/go")).toEqual(expect.arrayContaining(["gofmt","go vet"]));
  expect(l2Argv("go vet")).toEqual({ cmd: "go", args: ["vet", "./..."] });
});
it("l2 argv are check-only (never mutate)", () => {
  expect(l2Argv("cargo-fmt")).toEqual({ cmd: "cargo", args: ["fmt", "--check"] });
  expect(l2Argv("cargo-clippy")).toEqual({ cmd: "cargo", args: ["clippy", "--", "-D", "warnings"] });
  expect(l2Argv("prettier")).toEqual({ cmd: "prettier", args: ["--check", "."] });
  expect(l2Argv("gofmt")).toEqual({ cmd: "gofmt", args: ["-l", "."] });
  expect(l2Argv("ruff")).toEqual({ cmd: "ruff", args: ["check", "."] });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/l2.test.ts`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement `src/l2.ts` + fixtures**

Marker map per Interfaces. Run check-only commands; non-zero exit → findings; missing binary → skip silently.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/l2.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/l2.ts tests/l2.test.ts tests/fixtures/
git commit -m "feat: L2 native linters by config presence"
```

### Task 8: Prompt assembly (3 roles, XML, budget, linked issue)

**Files:**
- Create: `src/prompt.ts`
- Test: `tests/prompt.test.ts`

**Interfaces:**
- Consumes: `Finding[]` (fast), diff text, issue body?
- Produces: `export function buildMessages(fast: Finding[], diffText: string, issueBody?: string): { system: string, user: string }` + `export const PR_REVIEW_SCHEMA` (object `{ name: "pr_review", schema: {...}, strict: true }`) + `export function linkedIssueNumber(prBody?: string): number | null` (parses GitHub closing keywords `/(?:clos(?:e|es|ed)|fix(?:|es|ed)|resolv(?:e|es|ed))\s*:?\s+#(\d+)/i` — all 9: close/closes/closed/fix/fixes/fixed/resolve/resolves/resolved, optional colon — from the PR BODY only, never from diff text; body fetch is caller-side via API)

- [ ] **Step 1: Write the failing test**

```ts
import { buildMessages, PR_REVIEW_SCHEMA, linkedIssueNumber } from "../src/prompt.js";
it("wraps diff in xml and includes fast findings", () => {
  const m = buildMessages([{ severity: "high", file: "a", rule: "r", message: "m" }], "DIFF");
  expect(m.user).toContain("<untrusted-diff>");
  expect(m.system).toContain("security-reviewer");
  expect(PR_REVIEW_SCHEMA).toMatchObject({ name: "pr_review", strict: true });
  expect(PR_REVIEW_SCHEMA.schema.required).toContain("findings");
});
it("parses closing keywords from PR body only", () => {
  expect(linkedIssueNumber("Fixes #12")).toBe(12);
  expect(linkedIssueNumber("Closes #5")).toBe(5);
  expect(linkedIssueNumber("Resolves #7")).toBe(7);
  expect(linkedIssueNumber("Fixed #1")).toBe(1);
  expect(linkedIssueNumber("Closed #2")).toBe(2);
  expect(linkedIssueNumber("Resolved #3")).toBe(3);
  expect(linkedIssueNumber("Fixes: #4")).toBe(4);
  expect(linkedIssueNumber("no ref")).toBeNull();
  expect(linkedIssueNumber()).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/prompt.test.ts`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement `src/prompt.ts`**

System: three role sections + severity rubric + "never approve automatically". User: fast findings JSON + `<untrusted-diff>` block + optional issue context. Schema: `{findings: [{severity enum, file, line?, rule, message, suggestion?}]}` all-required, additionalProperties false.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/prompt.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/prompt.ts tests/prompt.test.ts
git commit -m "feat: review prompt and strict schema"
```

### Task 9: LLM call (gates, sampling validation, retry, refusal/finish, ollama)

**Files:**
- Create: `src/llm.ts`
- Test: `tests/llm.test.ts`

**Interfaces:**
- Consumes: `ResolvedEndpoint`, `{system,user}`, `PR_REVIEW_SCHEMA`, `{ model, apiKey, temperature?, topP?, maxTokens, timeoutSeconds, provider }`
- Produces: `export function validateSampling(o: { model: string, temperature?: number, topP?: number, n?: number, provider: string, apiStyle?: string }): void` (STRICT family only — matches `/\bo\d|gpt-5|gpt-6|claude.*4\.([7-9]|\d{2,})|claude.*[5-9]/i` (incl. `o1`, `O1`, `o3-mini`, `claude-4.8`, `claude-4.10`, `gpt-6-luna`, haiku-5-5/sonnet-5-5/opus-5-5): explicit non-default `temperature`, any `topP`, or `n!==1` → throw `/reasoning/`; check Anthropic-compat first so `claude-*`+`provider:"anthropic"` throws `/400|reasoning/` either way. GENERIC anthropic-compat (`provider==="anthropic" || apiStyle==="anthropic-messages"` on other models): only `n!==undefined && n!==1` → throw and both-set → throw; `temperature` range 0–1 and `topP` range 0–1 validated, never rejected by value. `openai` non-reasoning with any `n` → no-throw; all-undefined → no-throw) + `export function tokenFieldFor(model: string): "max_completion_tokens"|"max_tokens"` (OpenAI reasoning ONLY — `/\bo\d|gpt-5|gpt-6/i`, never Claude: `claude-sonnet-5-5`→`max_tokens` per Anthropic API) + `export function parseContent(raw: string): unknown` (strips ```json AND bare ``` fences via `/^```(?:json)?\s*|\s*```$/g`, JSON.parse, throws `InvalidJsonError`) + `export type LlmResult = { ok: true, findings: Finding[] } | { ok: false, reason: "no-key"|"unsupported"|"timeout"|"content-filter"|"invalid-json"|"http-error", detail: string }` + `export async function callLlm(ep: ResolvedEndpoint, messages: {system,user}, o: { model, apiKey, temperature?, topP?, maxTokens, timeoutSeconds, provider }): Promise<LlmResult>` + `export async function ensureOllama(baseUrl: string, model: string): Promise<void>` (healthcheck + `ollama pull`, throws `OllamaMissingError` on 404-without-pull)

- [ ] **Step 1: Write the failing test**

```ts
import { callLlm, validateSampling, tokenFieldFor, parseContent } from "../src/llm.js";
// Local helpers (define at top of tests/llm.test.ts): fakeAnthropicEp/fakeOllamaEp/fakeOpenAiEp/fakeEp(p)
// return {baseUrl,path,headers} per provider with dummy key; msgs() returns
// {system:"s",user:'{"findings":[]}'}; opts() returns {model:"m",apiKey:"k",maxTokens:50,timeoutSeconds:5,provider};
// callLlmFailing(key) mocks fetch 500 and returns the LlmResult (never throws);
// callLlmThrowing(key) mocks a network throw;
// refusalHonored(p) mocks fetch returning {refusal:"x"} and reports whether callLlm treated it as failure;
// callLlmWithTimeout/fetchCallCount use a hanging-fetch mock.
it("rejects bad sampling per family, allows generic ranges", () => {
  expect(() => validateSampling({ model: "o1", temperature: 0.5, provider: "openai" })).toThrow(/reasoning/);
  expect(() => validateSampling({ model: "o3-mini", provider: "openai", n: 2 })).toThrow(/reasoning/);
  expect(() => validateSampling({ model: "claude-sonnet-5-5", temperature: 0, provider: "anthropic" })).toThrow(/400|reasoning/);
  expect(() => validateSampling({ model: "x", provider: "anthropic", n: 2 })).toThrow(/n/);
  expect(() => validateSampling({ model: "m", provider: "custom", apiStyle: "anthropic-messages", temperature: 0.5, topP: 0.9 })).toThrow(/both|together/);
  expect(() => validateSampling({ model: "generic-claude", provider: "anthropic", temperature: 0.5 })).not.toThrow();
  expect(() => validateSampling({ model: "generic-claude", provider: "anthropic", topP: 0.9 })).not.toThrow();
  expect(() => validateSampling({ model: "gpt-6-luna", provider: "openai", topP: 0.9 })).toThrow(/reasoning/);
  expect(() => validateSampling({ model: "gpt-6-luna", provider: "openai", n: 2 })).toThrow(/reasoning/);
  expect(() => validateSampling({ model: "m", provider: "openai", n: 2 })).not.toThrow();
  expect(() => validateSampling({ model: "x", provider: "anthropic" })).not.toThrow();
});
it("maps reasoning to max_completion_tokens, never claude", () => {
  expect(tokenFieldFor("gpt-6-luna")).toBe("max_completion_tokens");
  expect(tokenFieldFor("o1")).toBe("max_completion_tokens");
  expect(tokenFieldFor("o3-mini")).toBe("max_completion_tokens");
  expect(tokenFieldFor("claude-sonnet-5-5")).toBe("max_tokens");
  expect(tokenFieldFor("deepseek-v4.1-flash")).toBe("max_tokens");
});
it("explicit sampling IS sent for openai non-reasoning, still omitted for anthropic", async () => {
  const e = await callLlm(fakeOpenAiEp(), msgs(), { ...opts(), model: "gpt-4o-mini", temperature: 0.3 });
  expect(e.sent.temperature).toBe(0.3);
  const a = await callLlm(fakeAnthropicEp(), msgs(), { ...opts(), temperature: 0.3 });
  expect(a.sent.temperature).toBeUndefined();
});
it("omits temperature/top_p/n by default", async () => {
  const d = await callLlm(fakeOpenAiEp(), msgs(), opts()); // opts() has no sampling
  expect(d.sent.temperature).toBeUndefined();
  expect(d.sent.top_p).toBeUndefined();
  expect(d.sent.n).toBeUndefined();
});
it("zen-chat gets strict full shape like openai", async () => {
  const z = await callLlm(fakeEp("opencode-zen"), msgs(), { ...opts(), model: "deepseek-v4.1-flash" });
  expect(z.sent.response_format).toMatchObject({ type: "json_schema", json_schema: { name: "pr_review", strict: true } });
});
it("response_format per provider: strict openai, json_object groq/mistral, omitted anthropic", async () => {
  const g = await callLlm(fakeEp("groq"), msgs(), opts());
  expect(g.sent.response_format.type).toBe("json_object");
  expect(g.sent.response_format.json_schema?.strict).not.toBe(true);
});
it("omits response_format for anthropic, non-strict for ollama, full shape for openai", async () => {
  const a = await callLlm(fakeAnthropicEp(), msgs(), opts()); // mocked fetch; helpers defined at top of file
  expect(a.sent.response_format).toBeUndefined();
  const ol = await callLlm(fakeOllamaEp(), msgs(), opts());
  expect(ol.sent.response_format).toBeDefined();
  expect(ol.sent.response_format.type).toBe("json_object");
  expect(ol.sent.response_format.json_schema?.strict).not.toBe(true);
  const o = await callLlm(fakeOpenAiEp(), msgs(), opts());
  expect(o.sent.response_format).toMatchObject({ type: "json_schema", json_schema: { name: "pr_review", strict: true } });
});
it("ignores refusal on anthropic, honors elsewhere", async () => {
  expect(await refusalHonored("anthropic")).toBe(false);
  expect(await refusalHonored("openai")).toBe(true);
  expect(await refusalHonored("ollama")).toBe(true);
});
it("strips markdown fences (json and bare) before parse", async () => {
  expect(parseContent("```json\n{\"findings\":[]}\n```")).toEqual({ findings: [] });
  expect(parseContent("```\n{\"findings\":[]}\n```")).toEqual({ findings: [] });
  expect(parseContent('  {"findings":[]}  ')).toEqual({ findings: [] });
});
it("timeout degrades without retry", async () => {
  const r = await callLlmWithTimeout(1);
  expect(r).toMatchObject({ ok: false, reason: "timeout" });
  expect(fetchCallCount()).toBe(1);
}, 15000);
it("never leaks api key in result or throw", async () => {
  const r = await callLlmFailing("sk-secret-xyz");
  expect(JSON.stringify(r)).not.toContain("sk-secret-xyz");
  const err = await callLlmThrowing("sk-secret-xyz").catch((e) => String(e));
  expect(err).not.toContain("sk-secret-xyz");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/llm.test.ts`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement `src/llm.ts`**

`fetch` with AbortController timeout; no key → `{ok:false,reason:"no-key"}`; `response_format` rule per provider (intentional downgrade where strict is partial/unsupported: strict full shape ONLY for `openai` + Zen/Go chat subset; `{type:"json_object"}` or non-strict schema for `groq`/`mistral`/`openrouter`/`ollama` — spec marks Groq/Mistral strict as partial, so v1 conservatively avoids `strict:true` there; omitted for Anthropic-compat. Anthropic-compat omits `temperature`/`top_p`/`n`; ollama sends `response_format` WITHOUT `strict:true` (`{type:"json_object"}` or non-strict schema — never `strict:true`); refusal honored for `openai/groq/mistral/openrouter/ollama/zen-chat`, ignored (always empty) for Anthropic-compat; `length` → degrade (no diff-shrink retry); `content_filter` → skip; 5xx/429 → 1 retry with backoff + `Retry-After`; fence-strip + `JSON.parse` + schema validation → invalid → `{reason:"invalid-json"}`; redact key in errors.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/llm.test.ts`
Expected: PASS (pins Review Focus: fence-wrapped JSON)

- [ ] **Step 5: Commit**

```bash
git add src/llm.ts tests/llm.test.ts
git commit -m "feat: BYOK LLM call with provider gates"
```

### Task 10: Review mapping + payload + fail_level matrix

**Files:**
- Create: `src/review.ts`
- Test: `tests/review.test.ts`

**Interfaces:**
- Consumes: `Finding[]` (fast+llm), parsed hunks, `headSha`, `failLevel: FailLevel`, `postComment`
- Produces: `export interface InlineComment { path: string, line: number, side: "LEFT"|"RIGHT", start_line?: number, start_side?: "LEFT"|"RIGHT", body: string }` + `export interface ReviewPayload { commit_id: string, body: string, event: "COMMENT"|"REQUEST_CHANGES", comments: InlineComment[] }` (never `APPROVE`, never `position`, never file-level multi) + `export function mapToComments(findings: Finding[], hunks: ParsedHunk[]): { inline: InlineComment[], general: Finding[] }` + `export function eventFor(failLevel: FailLevel, findings: Finding[]): "COMMENT"|"REQUEST_CHANGES"` + `export function exitFor(failLevel: FailLevel, findings: Finding[]): number` (`none`→0 always; `warning`→2 only if `findings.some(f=>f.severity!=="info")` else 0 — info-only never fails; template marks this check `continue-on-error: true` and branch protection must NOT require it; `high`→1 only on high-with-evidence else 0) + `export function buildBody(general: Finding[], summary: string): string` (always non-empty)

- [ ] **Step 1: Write the failing test**

```ts
import { mapToComments, eventFor, exitFor } from "../src/review.js";
// Local fixtures (define at top of tests/review.test.ts): hunksFixture() returns
// ParsedHunk[] with file a.ts where line 3 is a deletion and line 4 an addition
// (line 99 is outside every hunk); rangeFixture()
// returns a 3-line addition range at lines 8-10; highFinding() returns Finding[] with one high.
it("deletion maps LEFT, addition RIGHT, off-diff goes general", () => {
  const del = mapToComments([{ severity: "high", file: "a.ts", line: 3, rule: "r", message: "m" }], hunksFixture());
  expect(del.inline[0].side).toBe("LEFT");
  expect("position" in (del.inline[0] as object)).toBe(false);
  expect(del.inline[0].body).toBeTruthy();
  const add = mapToComments([{ severity: "info", file: "a.ts", line: 4, rule: "r", message: "m" }], hunksFixture());
  expect(add.inline[0].side).toBe("RIGHT");
  const off = mapToComments([{ severity: "info", file: "a.ts", line: 99, rule: "r", message: "m" }], hunksFixture());
  expect(off.inline).toEqual([]);
  expect(off.general.map((f) => f.file)).toContain("a.ts");
});
it("multi-line pairs start_line+start_side", () => {
  const r = mapToComments([{ severity: "warning", file: "a.ts", line: 10, rule: "r", message: "m", suggestion: "s" }], rangeFixture());
  expect(r.inline[0].start_line).toBeDefined();
  expect(r.inline[0].start_side).toBeDefined();
});
it("warning never requests changes; none never blocks; never APPROVE", () => {
  expect(eventFor("warning", highFinding())).toBe("COMMENT");
  expect(eventFor("none", highFinding())).toBe("COMMENT");
  expect(eventFor("high", [])).toBe("COMMENT");
  expect(eventFor("high", highFinding())).toBe("REQUEST_CHANGES");
});
it("exit codes pinned: none 0, warning 2 only above info, high 1 with evidence", () => {
  expect(exitFor("none", highFinding())).toBe(0);
  expect(exitFor("warning", [])).toBe(0);
  expect(exitFor("warning", [{ severity: "info", file: "a", rule: "r", message: "m" }])).toBe(0);
  expect(exitFor("warning", highFinding())).toBe(2);
  expect(eventFor("warning", highFinding())).toBe("COMMENT");
  expect(eventFor("high", [{ severity: "warning", file: "a", rule: "r", message: "m" }])).toBe("COMMENT");
  expect(exitFor("high", [{ severity: "warning", file: "a", rule: "r", message: "m" }])).toBe(0);
  expect(exitFor("high", [{ severity: "info", file: "a", rule: "r", message: "m" }])).toBe(0);
  expect(exitFor("high", highFinding())).toBe(1);
  expect(exitFor("high", [])).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/review.test.ts`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement `src/review.ts`**

Hunk parser computes side per line; multi-line ranges emit paired fields; off-diff/stale → general list appended to body. `eventFor`: `high`+evidence→`REQUEST_CHANGES` else `COMMENT`; `post_comment:false` handled by caller (dry-run). Body always non-empty.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/review.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/review.ts tests/review.test.ts
git commit -m "feat: hunk mapping and review payload"
```

### Task 11: GitHub API (post, fallback, head_sha, trigger guards)

**Files:**
- Create: `src/github.ts`
- Test: `tests/github.test.ts`

**Interfaces:**
- Consumes: octokit, `prNumber`, `ReviewPayload`
- Produces: `export class ReadonlyTokenError extends Error {}` + `export async function postReview(octokit: Octokit, pr: number, payload: ReviewPayload): Promise<void>` (422 line-off-diff → move to general + retry once; 422 stale sha → re-resolve head_sha + retry once) + `export async function postIssueFallback(...)` (only when enabled AND `issues:write`; else throw) + `export function resolvePrNumber(event: string, payload: { issue?: { number: number, pull_request?: unknown }, pull_request?: { number: number }, inputs?: { pr_number?: number } }): number | null` (issue without `pull_request` → null) + `export function shouldTrigger(event: string, payload: { action?: string, commentBody?: string, reviewBody?: string, authorAssociation?: string, issueHasPR?: boolean, prNumber?: number | null }): boolean` (`pull_request`→true ONLY for `action` in `opened|synchronize|reopened|ready_for_review`; `issue_comment` requires `action==="created"` + `issueHasPR===true` + body contains `/review` + association in OWNER/MEMBER/COLLABORATOR; `pull_request_review` requires `action==="submitted"` + non-empty review body AND association in OWNER/MEMBER/COLLABORATOR; `workflow_dispatch` requires `prNumber!=null`; `workflow_run`→false — Fluxo B dispatches on `github.event_name`, not this function)

- [ ] **Step 1: Write the failing test**

```ts
import { resolvePrNumber, shouldTrigger, postReview } from "../src/github.js";
// Local helpers (define at top of tests/github.test.ts): postReviewWithMock(calls)
// returns a mocked octokit whose first POST rejects 422 line-off-diff then succeeds,
// resolving {degraded:true}; postReviewStaleMock() mocks 422 stale commit_id then success
// resolving {retriedWithNewSha:true}; postReviewFailing(key) mocks a 500 returning the error
// result (never throws); postReviewThrowing(key) mocks a network throw.
it("issue without pull_request resolves null; review uses top-level pull_request; dispatch via inputs", () => {
  expect(resolvePrNumber("pull_request", { pull_request: { number: 7 } })).toBe(7);
  expect(resolvePrNumber("issue_comment", { issue: { number: 5 } })).toBeNull();
  expect(resolvePrNumber("issue_comment", { issue: { number: 5, pull_request: {} } })).toBe(5);
  expect(resolvePrNumber("pull_request_review", { pull_request: { number: 9 }, inputs: {} })).toBe(9);
  expect(resolvePrNumber("workflow_dispatch", { inputs: { pr_number: 11 } })).toBe(11);
  expect(resolvePrNumber("workflow_dispatch", { inputs: {} })).toBeNull();
});
it("shouldTrigger gates actions and events", () => {
  expect(shouldTrigger("pull_request", { action: "opened" })).toBe(true);
  expect(shouldTrigger("pull_request", { action: "synchronize" })).toBe(true);
  expect(shouldTrigger("pull_request", { action: "reopened" })).toBe(true);
  expect(shouldTrigger("pull_request", { action: "ready_for_review" })).toBe(true);
  expect(shouldTrigger("pull_request", { action: "labeled" })).toBe(false);
  expect(shouldTrigger("issue_comment", { commentBody: "LGTM", authorAssociation: "MEMBER", issueHasPR: true })).toBe(false);
  expect(shouldTrigger("issue_comment", { commentBody: "/review please", authorAssociation: "CONTRIBUTOR", issueHasPR: true })).toBe(false);
  expect(shouldTrigger("issue_comment", { commentBody: "/review", authorAssociation: "OWNER", issueHasPR: false })).toBe(false);
  expect(shouldTrigger("issue_comment", { action: "created", commentBody: "/review", authorAssociation: "OWNER", issueHasPR: true })).toBe(true);
  expect(shouldTrigger("issue_comment", { action: "edited", commentBody: "/review", authorAssociation: "OWNER", issueHasPR: true })).toBe(false);
  expect(shouldTrigger("workflow_dispatch", { prNumber: null })).toBe(false);
  expect(shouldTrigger("workflow_dispatch", { prNumber: 3 })).toBe(true);
  expect(shouldTrigger("workflow_run", {})).toBe(false);
});
it("shouldTrigger covers review association too", () => {
  expect(shouldTrigger("pull_request_review", { action: "submitted", reviewBody: "LGTM", authorAssociation: "MEMBER" })).toBe(true);
  expect(shouldTrigger("pull_request_review", { action: "edited", reviewBody: "LGTM", authorAssociation: "MEMBER" })).toBe(false);
  expect(shouldTrigger("pull_request_review", { action: "submitted", reviewBody: "LGTM", authorAssociation: "CONTRIBUTOR" })).toBe(false);
  expect(shouldTrigger("pull_request_review", { action: "submitted", reviewBody: "", authorAssociation: "MEMBER" })).toBe(false);
});
it("422 off-diff degrades to general and retries once; stale sha re-resolves", async () => {
  const calls: string[] = []; // mocked octokit: first POST rejects 422 line-off-diff, second succeeds
  const r = await postReviewWithMock(calls);
  expect(calls.filter((c) => c === "post").length).toBe(2);
  expect(r.degraded).toBe(true);
  const s = await postReviewStaleMock(); // first POST rejects 422 stale commit_id, re-resolves head_sha, retries
  expect(s.retriedWithNewSha).toBe(true);
});
it("never logs api key in result or throw", async () => {
  const r = await postReviewFailing("sk-secret-abc");
  expect(JSON.stringify(r)).not.toContain("sk-secret-abc");
  const err = await postReviewThrowing("sk-secret-abc").catch((e) => String(e));
  expect(err).not.toContain("sk-secret-abc");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/github.test.ts`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement `src/github.ts`**

Single consolidated `POST pulls/{n}/reviews`; fork read-only → throw `ReadonlyTokenError` (caller degrades to summary+artifact, no POST). Never log tokens.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/github.test.ts`
Expected: PASS (pins Review Focus: non-PR `/review` no-op, mid-run push re-resolve)

- [ ] **Step 5: Commit**

```bash
git add src/github.ts tests/github.test.ts
git commit -m "feat: review posting with fallback and guards"
```

### Task 12: Orchestration (Fluxo A + B) + templates with exact pins/guards

**Files:**
- Modify: `src/main.ts`
- Create: `docs/workflow-template.yml`, `docs/workflow-template-privileged.yml`
- Test: `tests/main.test.ts`, `tests/templates.test.ts`

**Interfaces:**
- Consumes: all Tasks 2–11
- Produces: working `run()`; `dist/index.js` built via `npm run build` (esbuild → `dist/index.js`, `node --check` clean)

- [ ] **Step 1: Write the failing tests**

```ts
// tests/main.test.ts — helpers defined at top: runWithMocks(stages) injects mocked
// diff/fastpath/llm/github stages and returns {posted, summaryWritten, exitCode, findingsFrom,
// slowPathSkipped, issueBodyFetched}; runPrivilegedWithSpies() installs spies
// that throw if checkout/scanners/llm are invoked.
it("no llm key still posts fast-path review", async () => {
  const r = await runWithMocks({ llmApiKey: "" });
  expect(r.posted).toBe(true);
  expect(r.findingsFrom).toBe("fastpath");
});
it("linked issue body enriches prompt when Fixes #n", async () => {
  const r = await runWithMocks({ prBody: "Fixes #12" });
  expect(r.issueBodyFetched).toBe(12);
});
it("fork readonly posts nothing, writes summary + artifact", async () => {
  const r = await runWithMocks({ forkReadonly: true });
  expect(r.posted).toBe(false);
  expect(r.summaryWritten).toBe(true);
});
it("privileged flow never calls checkout/scanners/llm", async () => {
  const calls = await runPrivilegedWithSpies(); // spies throw if checkout/scanners/llm invoked
  expect(calls.posted).toBe(true);
});
it("post_comment false and resolve-null/binary dry-run without post", async () => {
  const r = await runWithMocks({ postComment: false });
  expect(r.posted).toBe(false);
  const b = await runWithMocks({ binaryOnly: true });
  expect(b.posted).toBe(true);
  expect(b.slowPathSkipped).toBe(true);
  expect(b.exitCode).toBe(0);
  const n = await runWithMocks({ prNumber: null });
  expect(n.posted).toBe(false);
  expect(n.exitCode).toBe(0);
});
// tests/templates.test.ts
it("templates pin SHA, least privilege, guards, concurrency", () => {
  const t = fs.readFileSync("docs/workflow-template.yml", "utf8");
  expect(t).toContain("fetch-depth: 0");
  expect(t).toContain("persist-credentials: false");
  expect(t).toContain("pull/");
  expect(t).toContain("/head");
  expect(t).toContain("fetch");
  expect(t).toContain("git diff -U3");
  expect(t).toContain("base_sha");
  expect(t).not.toMatch(/run:\s*.*\bgit diff[^\\n]*\bHEAD(?!_SHA)\b/);
  expect(t).toContain("cancel-in-progress: true");
  expect(t).toContain("continue-on-error: true");
  expect(t).toContain("github.event.pull_request.number || github.event.issue.number || inputs.pr_number");
  expect(t).toContain("upload-artifact");
  expect(t).toContain("diff.patch");
  expect(t).toContain("pr-meta.json");
  expect(t).toContain("findings.json");
  expect(t).toContain("types: [created]");
  expect(t).toContain("types: [submitted]");
  expect(t).toContain("github.event.issue.pull_request");
  expect(t).toContain("opened");
  expect(t).toContain("synchronize");
  expect(t).toContain("reopened");
  expect(t).toContain("ready_for_review");
  expect(t).toContain("contents: read");
  expect(t).toContain("pull-requests: write");
  expect(t).not.toMatch(/checks:\s*write/);
  expect(t).toMatch(/issues:\s*write[\s\S]{0,200}fallback|fallback[\s\S]{0,200}issues:\s*write/);
  const p = fs.readFileSync("docs/workflow-template-privileged.yml", "utf8");
  expect(p).toContain("workflow_run");
  expect(p).toContain("types: [completed]");
  expect(p).toContain("conclusion == 'success'");
  expect(p).toContain("github.event.workflow_run.event == 'pull_request'");
  expect(p).toContain("pr-reviewer-priv-");
  expect(p).toContain("head_repository.full_name");
  expect(p).toContain("head_branch");
  expect(p).not.toMatch(/pull_requests\[0\]/);
  expect(p).toContain("contents: read");
  expect(p).toContain("pull-requests: write");
  expect(p).toContain("actions: read");
  expect(p).toContain("create-github-app-token@");
  expect(p).toMatch(/uses:\s*\S+@[0-9a-f]{40}/);
  expect(t).toMatch(/uses:\s*\S+@[0-9a-f]{40}/);
  expect(t).not.toMatch(/uses:\s*[^#\n]+@(v\d|main|master|latest)/);
  expect(p).not.toMatch(/uses:\s*[^#\n]+@(v\d|main|master|latest)/);
  expect(t).not.toMatch(/github\.event\.pull_request\.title|github\.event\.pull_request\.body/);
  expect(p).toContain("download-artifact");
  expect(p).toContain("diff.patch");
  expect(p).toContain("pr-meta.json");
  expect(p).toContain("findings.json");
  expect(p).not.toContain("upload-artifact");
  expect(t).not.toMatch(/pull_request_target/);
  expect(p).not.toMatch(/pull_request_target/);
  expect(p).toContain("run-id:");
  expect(p).toContain("runner.temp");
  expect(p).not.toMatch(/^\s*-\s*uses:\s*actions\/checkout\b/m);
  expect(p).not.toMatch(/run:\s*.*\b(checkout|semgrep|trivy|osv-scanner|ollama pull|chat\/completions)\b/m);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/main.test.ts tests/templates.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `run()` in `src/main.ts` + templates**

Fluxo A: `shouldTrigger`→resolve PR (null → log + exit 0) → checkout: `git fetch origin pull/<n>/head:<tmp-pr>` + fetch `base_sha` (`fetch-depth: 0`; `git diff -U3 BASE_SHA...HEAD_SHA` entre SHAs fetcheados, nunca `HEAD` do runner) → runL0+L1+L2 no UNFILTERED (ordem normativa Task 4: `runL0` antes de `filterForPrompt`) → upload artifact (`diff.patch`+`pr-meta.json`+`findings.json`) → `filterForPrompt` SÓ para o prompt → fetch PR body → `linkedIssueNumber` → se non-null fetch issue body → `buildMessages(fast, diff, issueBody)` → slow-path if key (ollama `ensureOllama` first when provider==ollama) → map → resolve `head_sha` via API antes do POST → post (or dry-run log) → exit code via `exitFor` per `fail_level`, e o step do warning check carrega `continue-on-error: true` para exit 2 nunca bloquear merge. Fluxo B (`workflow_run`): `download-artifact` only → validate → post. Templates carry exact guards, groups (`pr-reviewer-${{ ... }}` / `pr-reviewer-priv-${{ head_repository }}-${{ head_branch }}`), `run-id`/`path`, `create-github-app-token@<SHA>`, permissions (`contents:read,pull-requests:write` + conditional `issues:write`/`security-events:write`; privileged adds `actions:read`).

- [ ] **Step 4: Run full suite + build**

Run: `npx vitest run`
Expected: PASS
Run: `npm run build && node --check dist/index.js`
Expected: clean

- [ ] **Step 5: Commit**

```bash
git add src/main.ts docs/workflow-template.yml docs/workflow-template-privileged.yml tests/main.test.ts tests/templates.test.ts dist/index.js
git commit -m "feat: orchestrate flows A and B"
```

### Task 13: README + release docs

**Files:**
- Create: `README.md`
- Test: `tests/readme.test.ts`

**Interfaces:**
- Consumes: spec §§3,5,8
- Produces: user docs

- [ ] **Step 1: Write the failing test**

```ts
it("readme covers providers costs fork dry-run and levels", () => {
  const r = fs.readFileSync("README.md", "utf8");
  for (const s of ["opencode-zen", "opencode-go", "workflow_run", "post_comment", "fail_level", "typical", "peak/off-peak", "Zen vs direto", "v1", "v2", "fork", "App", "two-workflow", "artifact", "dry-run", "REQUEST_CHANGES"]) expect(r).toContain(s);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/readme.test.ts`
Expected: FAIL (README missing)

- [ ] **Step 3: Write `README.md`**

Install (copy template, create `LLM_API_KEY` or omit), provider table with v1-chat vs v2 split, Zen/Go keys/headers/limits (Go caps + Zen fallback), fork App-token two-workflow, cost typical (~3k+600) vs ceiling (60k≈15k, frontier ≈$0.15–0.30) + peak/off-peak + Zen-vs-direto, `fail_level` semantics, `post_comment:false` dry-run.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/readme.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add README.md tests/readme.test.ts
git commit -m "docs: user README and templates"
```

### Task 14: Integration, E2E checklist, release

**Files:**
- Create: `.github/workflows/ci.yml`, `docs/e2e-checklist.md`
- Test: `tests/ci.test.ts` + manual (documented commands)

**Interfaces:**
- Consumes: Tasks 1–13
- Produces: green CI + release procedure (immutable tag + floating `v1` after canary + marketplace entry)

- [ ] **Step 1: Write CI workflow + its test (fails until files exist)**

```ts
// tests/ci.test.ts
it("ci covers build matrix fork-sim checks and SHA pins", () => {
  const c = fs.readFileSync(".github/workflows/ci.yml", "utf8");
  for (const s of ["npm ci", "vitest run", "node --check", "ubuntu", "macos", "windows", "fork", "ollama", "concurrency"]) expect(c).toContain(s);
  expect(c).toMatch(/uses:\s*\S+@[0-9a-f]{40}/);
  expect(c).not.toMatch(/uses:\s*[^#\n]+@(v\d|main|master|latest)/);
});
```

Create `.github/workflows/ci.yml` (all third-party `uses:` pinned by SHA): `npm ci` → `npx vitest run` → `npm run build` → `node --check dist/index.js` → `uses: ./` smoke on ubuntu/macos/windows matrix → fork-sim job (no secret asserts summary-only, no POST) → SARIF-conditional, ollama, guards, concurrency jobs.

- [ ] **Step 2: Run locally to verify green**

Run: `npm ci && npx vitest run && npm run build && node --check dist/index.js`
Expected: all PASS, dist non-empty diff

- [ ] **Step 3: Write `docs/e2e-checklist.md`**

Synthetic PR cases: secret leak, SQLi, race, giant diff, force-push, deleted line, multi-line, fork PR, `/review` retrigger — each with expected event/body assertions.

- [ ] **Step 4: Document release**

Tag immutable (`git tag v0.1.0` + SHA), move `v1` only after canary, marketplace metadata from `action.yml`.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml docs/e2e-checklist.md
git commit -m "ci: integration workflow and e2e checklist"
```

---

### Task 15: Responses adapter (`openai-responses`)

**Files:**
- Create: `src/adapters/responses.ts`
- Test: `tests/adapters-responses.test.ts`

**Interfaces:**
- Consumes: `ResolvedEndpoint` (baseUrl+path ending `/responses`), `{system, user}` messages, `PR_REVIEW_SCHEMA`, `{model, apiKey, temperature?, topP?, maxTokens, timeoutSeconds}`
- Produces: `export async function callResponses(ep, messages, o): Promise<LlmResult>` (same LlmResult union as Task 9) — request `{model, input:[{role,content}...], max_output_tokens?, text:{format:{type:"json_schema",...}} where supported}`; temperature/top_p omitted by default (validateSampling shared); `text.format` 400 → single retry without format + manual parse; response joins `output[].content[]` output_text/text; `refusal` item → content-filter skip; `incomplete` → degrade (length-equivalent); timeout/retry/redact rules identical to Task 9

- [ ] **Step 1: Write the failing tests**

```ts
it("posts input array + max_output_tokens + strict format", ...); // assert exact body via fetch mock
it("falls back without format on 400", ...);
it("joins output_text parts and parses findings", ...);
it("refusal item → content-filter skip; incomplete → degrade", ...);
it("reasoning model maps max_completion_tokens→max_output_tokens", ...);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/adapters-responses.test.ts`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement `src/adapters/responses.ts`**

Per spec §9.1. Reuse Task 9 helpers where importable (redact, retry, timeout, parse/validate); do NOT duplicate them — import from llm.ts (export what's needed first as a tiny refactor of llm.ts with no behavior change, covered by existing tests).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/adapters/responses.ts tests/adapters-responses.test.ts src/llm.ts tests/llm.test.ts
git commit -m "feat: openai-responses adapter"
```

### Task 16: Messages adapter (`anthropic-messages`)

**Files:**
- Create: `src/adapters/messages.ts`
- Test: `tests/adapters-messages.test.ts`

**Interfaces:**
- Consumes: same as Task 15
- Produces: `export async function callMessages(ep, messages, o): Promise<LlmResult>` — headers `x-api-key` + `anthropic-version: 2023-06-01` (+ User-Agent/session from endpoint); body `{model, max_tokens (REQUIRED from maxTokens), system, messages:[{role:"user",content}]}`; NEVER temperature/top_p/n/response_format by default (validateSampling shared); response concatenates `content[].text`; `stop_reason` end_turn→ok, max_tokens→degrade, refusal→skip; same timeout/retry/redact rules

Steps 1-5 mirror Task 15 (failing tests → fail → implement → pass → commit `feat: anthropic-messages adapter`).

### Task 17: Google adapter (`google-models`)

**Files:**
- Create: `src/adapters/google.ts`
- Test: `tests/adapters-google.test.ts`

**Interfaces:**
- Consumes: same as Task 15 (endpoint path contains `/models/`)
- Produces: `export async function callGoogle(ep, modelId, messages, o): Promise<LlmResult>` — `{contents:[{role:"user",parts:[{text}]}], systemInstruction:{parts:[{text}]}, generationConfig:{responseMimeType:"application/json", responseSchema:<schema>, maxOutputTokens}}`; on 400 retry without responseSchema/responseMimeType + manual parse; response `candidates[0].content.parts[]` text join; `finishReason` STOP→ok, MAX_TOKENS→degrade, SAFETY/other→skip no retry; auth prefer `x-goog-api-key` header (fallback `?key=` — never log); same timeout/retry/redact rules

Steps 1-5 mirror Task 15 (commit `feat: google-models adapter`).

### Task 18: Adapter routing + matrix + docs

**Files:**
- Modify: `src/providers.ts` (auto resolves NON_CHAT pairs to their adapter instead of fail-fast), `src/llm.ts` (dispatch by resolved apiStyle: openai-chat→callLlm, responses→callResponses, messages→callMessages, google→callGoogle), `README.md` (adapter table + per-provider notes), `docs/workflow-template.yml` (comment documenting llm_api_style values — comment only)
- Test: `tests/adapters-routing.test.ts`

**Interfaces:**
- Consumes: all adapter tasks
- Produces: `auto` end-to-end per pair (zen gpt-6-luna→responses, zen claude-sonnet-5-5→messages, zen gemini-3.8-flash→google, go qwen3.8-max→messages, go gpt-6-luna→responses); explicit styles functional; unknown pairs still fail-fast

- [ ] **Step 1: Write failing tests** (routing table incl. the 5 pairs above + chat pairs unchanged + fail-fast for truly-unknown `custom` model with v2 style... per plan: custom non-chat without v2 → path-only error stays)
- [ ] **Step 2: Run → FAIL** (`npx vitest run tests/adapters-routing.test.ts`)
- [ ] **Step 3: Implement** (providers auto-map update + llm.ts dispatcher + README section + template comment)
- [ ] **Step 4: Run → PASS** (full `npx vitest run` + `npm run build` + `node --check dist/index.js`)
- [ ] **Step 5: Commit** (`git add` the touched files; `feat: adapter routing, matrix and docs`)
