import * as fs from "node:fs";
import { describe, expect, it } from "vitest";

const CI = ".github/workflows/ci.yml";

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

  it("fork-sim runs without secrets, never posts, and asserts the summary-only path", () => {
    const c = fs.readFileSync(CI, "utf8");
    const fork = c.slice(c.indexOf("fork-sim:"));
    expect(fork).toMatch(/post_comment:\s*"false"/);
    expect(fork).not.toMatch(/secrets\.LLM_API_KEY/);
    expect(fork).not.toMatch(/secrets\.[A-Z_]+/);
    expect(fork).toContain("GITHUB_STEP_SUMMARY");
  });

  it("no workflow-level secret or pull_request_target trigger", () => {
    const c = fs.readFileSync(CI, "utf8");
    expect(c).not.toMatch(/pull_request_target/);
    expect(c).toMatch(/permissions:\s*\n\s*contents:\s*read/);
  });

  it("scanner image digests are real sha256 values, not placeholders", () => {
    const s = fs.readFileSync("src/scanners.ts", "utf8");
    for (const name of ["TRIVY_DIGEST", "OSV_DIGEST", "GITLEAKS_DIGEST"]) {
      const m = s.match(new RegExp(`export const ${name} = "sha256:([^"]*)"`));
      expect(m, `${name} missing`).not.toBeNull();
      expect(m![1], `${name} is a placeholder`).toMatch(/^[0-9a-f]{64}$/);
      expect(m![1]).not.toMatch(/^0+$/);
    }
  });

  it("release docs document the SHA substitution and the immutable tag + floating v1 procedure", () => {
    const d = fs.readFileSync("docs/e2e-checklist.md", "utf8");
    expect(d).toContain("git tag -a v0.1.0");
    expect(d).toContain("v1");
    expect(d).toMatch(/canary/i);
    expect(d).toContain("OWNER/pr-reviewer@0000000000000000000000000000000000000000");
    expect(d).toMatch(/marketplace/i);
  });
});
