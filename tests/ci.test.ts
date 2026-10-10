import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const CI = ".github/workflows/ci.yml";

/** Text of one job: from its `  key:` header to the next job header (or end of the jobs section). */
function jobBlock(c: string, key: string): string {
  const lines = c.split("\n");
  const start = lines.findIndex((l) => l === `  ${key}:`);
  if (start === -1) throw new Error(`job ${key} not found`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[i]) || /^\S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/** Text before the `jobs:` key: workflow-level keys only. */
function topLevel(c: string): string {
  return c.slice(0, c.search(/^jobs:\s*$/m));
}

function jobKeys(c: string): string[] {
  const jobs = c.slice(c.search(/^jobs:\s*$/m));
  return [...jobs.matchAll(/^  ([A-Za-z0-9_-]+):\s*$/gm)].map((m) => m[1]);
}

/** Every .ts file under a directory, recursively. */
function tsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? tsFiles(p) : e.name.endsWith(".ts") ? [p] : [];
  });
}

describe("ci workflow", () => {
  it("ci covers build matrix fork-sim checks and SHA pins", () => {
    const c = fs.readFileSync(CI, "utf8");
    for (const s of ["npm ci", "vitest run", "node --check", "ubuntu", "macos", "windows", "fork", "ollama", "concurrency"]) expect(c).toContain(s);
    expect(c).toMatch(/uses:\s*\S+@[0-9a-f]{40}/);
    expect(c).not.toMatch(/uses:\s*[^#\n]+@(v\d|main|master|latest)/);
  });

  it("every third-party uses: is pinned by a full 40-hex commit SHA", () => {
    const c = fs.readFileSync(CI, "utf8");
    const uses = [...c.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)].map((m) => m[1]);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) {
      if (u.startsWith("./")) continue;
      expect(u, `unpinned: ${u}`).toMatch(/^[^@\s]+@[0-9a-f]{40}$/);
    }
  });

  it("ci runs the build pipeline in order and smoke-tests the action on the OS matrix", () => {
    const c = fs.readFileSync(CI, "utf8");
    const npmCi = c.indexOf("npm ci");
    const vitest = c.indexOf("vitest run");
    const build = c.indexOf("npm run build");
    const check = c.indexOf("node --check dist/index.js");
    expect(npmCi).toBeGreaterThan(-1);
    expect(npmCi).toBeLessThan(vitest);
    expect(vitest).toBeLessThan(build);
    expect(build).toBeLessThan(check);
    expect(c).toMatch(/uses:\s*\.\//);
    expect(c).toMatch(/os:\s*\[\s*ubuntu-latest,\s*macos-latest,\s*windows-latest\s*\]/);
  });

  it("no-secret smoke simulates a fork: no secrets, summary-only, job-scoped assertions", () => {
    const c = fs.readFileSync(CI, "utf8");
    const job = jobBlock(c, "no-secret-smoke");
    expect(job).toMatch(/post_comment:\s*"false"/);
    expect(job).toContain("GITHUB_STEP_SUMMARY");
    expect(job).toContain("simulates fork");
    expect(job).not.toMatch(/secrets\./);
    expect(job).not.toMatch(/\bPOST\b/);
  });

  it("no workflow-level secrets (job-level secrets are allowed where a job needs them)", () => {
    const c = fs.readFileSync(CI, "utf8");
    expect(topLevel(c)).not.toMatch(/secrets\./);
    expect(c).not.toMatch(/pull_request_target/);
    expect(c).toMatch(/permissions:\s*\n\s*contents:\s*read/);
  });

  it("every CI job declares timeout-minutes with the agreed budget", () => {
    const c = fs.readFileSync(CI, "utf8");
    const expected: Record<string, number> = {
      build: 20,
      smoke: 30,
      "no-secret-smoke": 20,
      sarif: 20,
      ollama: 20,
      guards: 10,
    };
    expect(jobKeys(c).sort()).toEqual(Object.keys(expected).sort());
    for (const [key, minutes] of Object.entries(expected)) {
      expect(jobBlock(c, key), `${key} timeout`).toMatch(new RegExp(`timeout-minutes:\\s*${minutes}\\b`));
    }
  });

  it("cancel-in-progress is limited to pull_request events (main-branch runs are never cancelled)", () => {
    const c = fs.readFileSync(CI, "utf8");
    expect(topLevel(c)).toMatch(/cancel-in-progress:\s*\$\{\{\s*github\.event_name == 'pull_request'\s*\}\}/);
    expect(topLevel(c)).not.toMatch(/cancel-in-progress:\s*true/);
  });

  it("ollama job runs no remote install script and no ollama server (mock-based only)", () => {
    const c = fs.readFileSync(CI, "utf8");
    const job = jobBlock(c, "ollama");
    expect(job).not.toMatch(/curl\b/);
    expect(job).not.toMatch(/\|\s*sh\b/);
    expect(job).not.toMatch(/ollama serve/);
    expect(job).toContain("npx vitest run tests/llm.test.ts tests/providers.test.ts");
  });

  it("scanner digests are real sha256 values, and src/, ci.yml, action.yml hold no placeholders", () => {
    const s = fs.readFileSync("src/scanners.ts", "utf8");
    for (const name of ["TRIVY_DIGEST", "OSV_DIGEST", "GITLEAKS_DIGEST"]) {
      const m = s.match(new RegExp(`export const ${name} = "sha256:([^"]*)"`));
      expect(m, `${name} missing`).not.toBeNull();
      expect(m![1], `${name} is a placeholder`).toMatch(/^[0-9a-f]{64}$/);
    }
    const scanned = [...tsFiles("src"), CI, "action.yml"];
    for (const f of scanned) {
      const text = fs.readFileSync(f, "utf8");
      expect(text, `placeholder SHA in ${f}`).not.toMatch(/0{40}/);
      expect(text, `placeholder digest in ${f}`).not.toMatch(/sha256:0{64}/);
    }
  });

  it("action.yml declares Marketplace branding", () => {
    const a = fs.readFileSync("action.yml", "utf8");
    expect(a).toMatch(/^branding:\s*\n\s*icon:\s*"git-pull-request"\s*\n\s*color:\s*"blue"\s*$/m);
  });

  it("release docs: immutable tag, SHA substitution in both templates, v1 move, canary, marketplace, in that order", () => {
    const d = fs.readFileSync("docs/e2e-checklist.md", "utf8");
    expect(d).toContain("git tag -a v0.1.0");
    expect(d).toContain("v1");
    expect(d).toMatch(/canary/i);
    expect(d).toContain("OWNER/pr-reviewer@0000000000000000000000000000000000000000");
    expect(d).toMatch(/marketplace/i);
    expect(d).toContain("docs/workflow-template.yml docs/workflow-template-privileged.yml");
    expect(d).toMatch(/never copy them from the v0\.1\.0 tag/i);
    const release = d.slice(d.indexOf("## Release procedure")).toLowerCase();
    const order = ["git tag -a v0.1.0", "rev-parse", "docs/workflow-template-privileged.yml", "git tag -f v1", "canary", "marketplace"];
    const idx = order.map((s) => release.indexOf(s));
    for (const i of idx) expect(i).toBeGreaterThan(-1);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });
});
