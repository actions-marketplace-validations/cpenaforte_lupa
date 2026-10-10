import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  semgrepArgv,
  shouldUploadSarif,
  isSameRepo,
  resolveJobs,
  gitleaksArgv,
  trivyArgv,
  sbomArgv,
  osvArgv,
  parseSarif,
  runScanners,
  TRIVY_IMAGE,
  TRIVY_DIGEST,
  OSV_VERSION,
  OSV_DIGEST,
  GITLEAKS_IMAGE,
  GITLEAKS_DIGEST,
  SEMGREP_VERSION,
} from "../src/scanners.js";

// ---- argv / gating / pins ------------------------------------------------

describe("argv builders and gates", () => {
  it("no-token argv uses scan+sarif+baseline-commit and no env", () => {
    const r = semgrepArgv({ baselineSha: "abc", jobs: 4, hasToken: false });
    expect(r.argv).toEqual([
      "scan",
      "--config",
      "auto",
      "--sarif",
      "--metrics=off",
      "--jobs",
      "4",
      "--baseline-commit",
      "abc",
    ]);
    expect(r.env.SEMGREP_BASELINE_COMMIT).toBeUndefined();
  });

  it("token argv uses ci+sarif with baseline env, exact shape", () => {
    const r = semgrepArgv({ baselineSha: "abc", jobs: 4, hasToken: true });
    expect(r.argv).toEqual(["ci", "--sarif", "--metrics=off", "--jobs", "4"]);
    expect(r.env.SEMGREP_BASELINE_COMMIT).toBe("abc");
  });

  it("sbom argv generates cyclonedx via fs scan", () => {
    expect(sbomArgv(".")).toEqual(["fs", "--format", "cyclonedx", "."]);
  });

  it("gitleaks argv uses dir, sarif format and a report path (detect deprecated)", () => {
    expect(gitleaksArgv(".", "/out/report.sarif")).toEqual([
      "dir",
      ".",
      "--report-format",
      "sarif",
      "--report-path",
      "/out/report.sarif",
    ]);
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
});

// ---- SARIF parsing -------------------------------------------------------

describe("parseSarif", () => {
  it("maps SARIF levels to severities and reads location", () => {
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
    expect(parseSarif(sarif)).toEqual([
      { severity: "high", file: "a.ts", line: 7, rule: "R1", message: "bad" },
      { severity: "info", file: "", rule: "R2", message: "meh" },
    ]);
  });

  it("missing SARIF level defaults to warning", () => {
    const sarif = JSON.stringify({ runs: [{ results: [{ ruleId: "R3", message: { text: "no level" } }] }] });
    expect(parseSarif(sarif)).toEqual([
      { severity: "warning", file: "", rule: "R3", message: "no level" },
    ]);
  });

  it("returns undefined for invalid JSON or a non-SARIF document (never silent [])", () => {
    expect(parseSarif("not json")).toBeUndefined();
    expect(parseSarif("{}")).toBeUndefined();
    expect(parseSarif('{"runs":"x"}')).toBeUndefined();
  });

  it("empty but valid SARIF is a clean result, not a failure", () => {
    expect(parseSarif('{"runs":[]}')).toEqual([]);
  });

  it("null-guards runs/results/locations without throwing", () => {
    const sarif = JSON.stringify({
      runs: [null, { results: "x" }, { results: [null, { ruleId: "R", locations: [null, 3] }] }],
    });
    expect(parseSarif(sarif)).toEqual([{ severity: "warning", file: "", rule: "R", message: "scanner finding" }]);
  });
});

// ---- runScanners with fake binaries on PATH ------------------------------

const FAKE_SEMGREP_CLEAN = `#!/bin/sh\nprintf '%s' '{"runs":[]}'\nexit 0\n`;

/**
 * Fake docker. Records every invocation in $SCAN_LOG; answers the CycloneDX request with
 * a JSON document; for gitleaks (the only call mounting `:/out`) writes a SARIF report
 * unless $NO_REPORT is set; exits with $FAKE_EXIT (default 0).
 */
const FAKE_DOCKER = `#!/bin/sh
echo "$*" >> "$SCAN_LOG"
case "$*" in
  *cyclonedx*) printf '%s' '{"bomFormat":"CycloneDX"}'; exit 0;;
esac
for a in "$@"; do case "$a" in *:/out) host="\${a%:/out}";; esac; done
if [ -n "$host" ]; then
  echo "$host" >> "$SCAN_LOG.reportdirs"
  if [ -z "$NO_REPORT" ]; then
    printf '%s' '{"runs":[{"results":[{"ruleId":"G1","level":"error","message":{"text":"secret"},"locations":[{"physicalLocation":{"artifactLocation":{"uri":"x.env"},"region":{"startLine":2}}}]}]}]}' > "$host/report.sarif"
  fi
fi
printf '%s' '{"runs":[]}'
exit "\${FAKE_EXIT:-0}"
`;

function makeBin(scripts: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "scan-bin-"));
  for (const [name, body] of Object.entries(scripts)) {
    const p = join(d, name);
    writeFileSync(p, body);
    chmodSync(p, 0o755);
  }
  return d;
}

describe("runScanners", () => {
  let savedPath: string | undefined;
  let tmp: string;
  let log: string;

  beforeEach(() => {
    savedPath = process.env.PATH;
    tmp = mkdtempSync(join(tmpdir(), "scan-test-"));
    log = join(tmp, "calls.log");
    process.env.SCAN_LOG = log;
  });

  afterEach(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    delete process.env.SCAN_LOG;
    delete process.env.NO_REPORT;
    delete process.env.FAKE_EXIT;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("missing binaries yield scanner-missing warnings and never throw", async () => {
    process.env.PATH = makeBin({}); // empty PATH dir: semgrep and docker both ENOENT
    const r = await runScanners({
      dir: tmp,
      baselineSha: "abc",
      lockfiles: ["a/package-lock.json"],
      sbom: true,
      outDir: tmp,
    });
    expect(r.findings.length).toBe(5); // semgrep, trivy, gitleaks, osv(a), sbom
    for (const f of r.findings) {
      expect(f.severity).toBe("warning");
      expect(f.rule).toBe("scanner-missing");
    }
    expect(r.sbomPath).toBeUndefined();
  });

  it("parses SARIF from a semgrep run that exits non-zero (findings present)", async () => {
    const sarif = `{"runs":[{"results":[{"ruleId":"S1","level":"error","message":{"text":"sg"},"locations":[{"physicalLocation":{"artifactLocation":{"uri":"a.ts"},"region":{"startLine":3}}}]}]}]}`;
    process.env.PATH = makeBin({
      semgrep: `#!/bin/sh\nprintf '%s' '${sarif}'\nexit 1\n`,
      docker: FAKE_DOCKER,
    });
    const { findings } = await runScanners({ dir: tmp, baselineSha: "abc" });
    expect(findings).toContainEqual({ severity: "high", file: "a.ts", line: 3, rule: "S1", message: "sg" });
    expect(findings.some((f) => f.rule === "scanner-failed")).toBe(false);
  });

  it("non-zero exit with empty stdout is a scanner-failed warning, never a clean pass", async () => {
    process.env.PATH = makeBin({
      semgrep: `#!/bin/sh\nexit 2\n`,
      docker: FAKE_DOCKER,
    });
    const { findings } = await runScanners({ dir: tmp, baselineSha: "abc" });
    expect(findings).toContainEqual({
      severity: "warning",
      file: "",
      rule: "scanner-failed",
      message: "semgrep exited 2 without parseable SARIF",
    });
  });

  it("exit 0 with unparseable stdout is a scanner-failed warning", async () => {
    process.env.PATH = makeBin({
      semgrep: `#!/bin/sh\nprintf '%s' 'garbage'\nexit 0\n`,
      docker: FAKE_DOCKER,
    });
    const { findings } = await runScanners({ dir: tmp, baselineSha: "abc" });
    expect(findings.some((f) => f.rule === "scanner-failed" && f.message.startsWith("semgrep"))).toBe(true);
  });

  it("runs osv-scanner once per lockfile", async () => {
    process.env.PATH = makeBin({ semgrep: FAKE_SEMGREP_CLEAN, docker: FAKE_DOCKER });
    await runScanners({ dir: tmp, baselineSha: "abc", lockfiles: ["a/package-lock.json", "b/Cargo.lock"] });
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("scan -L a/package-lock.json --format sarif");
    expect(calls).toContain("scan -L b/Cargo.lock --format sarif");
  });

  it("gitleaks reads its report file, parses it and removes the temp dir", async () => {
    process.env.PATH = makeBin({ semgrep: FAKE_SEMGREP_CLEAN, docker: FAKE_DOCKER });
    const { findings } = await runScanners({ dir: tmp, baselineSha: "abc" });
    expect(findings).toContainEqual({ severity: "high", file: "x.env", line: 2, rule: "G1", message: "secret" });
    const reportDir = readFileSync(`${log}.reportdirs`, "utf8").trim();
    expect(reportDir).not.toBe("");
    expect(existsSync(reportDir)).toBe(false);
  });

  it("gitleaks exit 0 with no report is clean; non-zero exit with no report is scanner-failed", async () => {
    process.env.PATH = makeBin({ semgrep: FAKE_SEMGREP_CLEAN, docker: FAKE_DOCKER });
    process.env.NO_REPORT = "1";
    const clean = await runScanners({ dir: tmp, baselineSha: "abc" });
    expect(clean.findings).toEqual([]);

    process.env.FAKE_EXIT = "3";
    const failed = await runScanners({ dir: tmp, baselineSha: "abc" });
    expect(failed.findings).toContainEqual({
      severity: "warning",
      file: "",
      rule: "scanner-failed",
      message: "gitleaks exited 3 with no report",
    });
  });

  it("sbom is written to outDir and its path is returned", async () => {
    process.env.PATH = makeBin({ semgrep: FAKE_SEMGREP_CLEAN, docker: FAKE_DOCKER });
    const outDir = mkdtempSync(join(tmpdir(), "sbom-out-"));
    try {
      const r = await runScanners({ dir: tmp, baselineSha: "abc", sbom: true, outDir });
      expect(r.sbomPath).toBe(join(outDir, "sbom.cdx.json"));
      expect(readFileSync(r.sbomPath as string, "utf8")).toBe('{"bomFormat":"CycloneDX"}');
      expect(r.findings.some((f) => f.rule === "sbom")).toBe(false);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
