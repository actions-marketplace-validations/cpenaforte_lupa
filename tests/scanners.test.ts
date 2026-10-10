import { describe, it, expect, afterEach } from "vitest";
import {
  semgrepArgv,
  shouldUploadSarif,
  isSameRepo,
  resolveJobs,
  gitleaksArgv,
  trivyArgv,
  sbomArgv,
  osvArgv,
  sarifToFindings,
  runScanners,
  TRIVY_IMAGE,
  TRIVY_DIGEST,
  OSV_VERSION,
  OSV_DIGEST,
  GITLEAKS_IMAGE,
  GITLEAKS_DIGEST,
  SEMGREP_VERSION,
} from "../src/scanners.js";

describe("scanners L1", () => {
  it("no-token argv uses scan+baseline-commit and no env", () => {
    const r = semgrepArgv({ baselineSha: "abc", jobs: 4, hasToken: false });
    expect(r.argv).toEqual(["scan", "--config", "auto", "--metrics=off", "--jobs", "4", "--baseline-commit", "abc"]);
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
    expect(shouldUploadSarif({ isSameRepo: true, hasPermission: false, codeScanningEnabled: true })).toBe(false);
    expect(shouldUploadSarif({ isSameRepo: true, hasPermission: true, codeScanningEnabled: false })).toBe(false);
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
    expect(SEMGREP_VERSION).toBe("1.180.0");
  });

  it("sarifToFindings maps SARIF results to Finding", () => {
    const sarif = JSON.stringify({
      runs: [
        {
          results: [
            {
              ruleId: "R1",
              level: "error",
              message: { text: "bad" },
              locations: [{ physicalLocation: { artifactLocation: { uri: "a.ts" }, region: { startLine: 7 } } }],
            },
            { ruleId: "R2", level: "note", message: { text: "meh" }, locations: [] },
          ],
        },
      ],
    });
    expect(sarifToFindings(sarif, "trivy")).toEqual([
      { severity: "high", file: "a.ts", line: 7, rule: "R1", message: "bad" },
      { severity: "info", file: "", line: undefined, rule: "R2", message: "meh" },
    ]);
  });
});

describe("runScanners", () => {
  const savedPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = savedPath;
  });

  it("missing binaries yield warning findings and never throw", async () => {
    process.env.PATH = "";
    const findings = await runScanners({ dir: "/tmp", baselineSha: "abc" });
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      expect(f.severity).toBe("warning");
      expect(f.rule).toBe("scanner-missing");
    }
  });
});
