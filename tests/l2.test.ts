import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectL2Tools, l2Argv, runL2, type ToolFailure } from "../src/l2.js";

const tmpDirs: string[] = [];
function makeTmp(files: Record<string, string> = {}, dirs: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), "l2-"));
  tmpDirs.push(dir);
  for (const d of dirs) mkdirSync(join(dir, d), { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

let savedPath: string | undefined;
beforeEach(() => {
  savedPath = process.env.PATH;
});
afterEach(() => {
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("L2 detection by config presence", () => {
  it("detects cargo pair and prettier by markers", () => {
    expect(detectL2Tools("tests/fixtures/rust-node")).toEqual(
      expect.arrayContaining(["cargo-fmt", "cargo-clippy", "prettier"]),
    );
    expect(detectL2Tools("tests/fixtures/empty")).toEqual([]);
  });

  it("detects eslint/ruff markers too", () => {
    expect(detectL2Tools("tests/fixtures/rust-node")).toEqual(expect.arrayContaining(["eslint"]));
    expect(detectL2Tools("tests/fixtures/python")).toEqual(expect.arrayContaining(["ruff"]));
    expect(detectL2Tools("tests/fixtures/gofmt")).toEqual(expect.arrayContaining(["gofmt"]));
  });

  it("detects gofmt+go vet by go.mod and splits argv", () => {
    expect(detectL2Tools("tests/fixtures/go")).toEqual(expect.arrayContaining(["gofmt", "go vet"]));
    expect(l2Argv("go vet")).toEqual({ cmd: "go", args: ["vet", "./..."] });
  });

  it("l2 argv are check-only (never mutate)", () => {
    expect(l2Argv("cargo-fmt")).toEqual({ cmd: "cargo", args: ["fmt", "--check"] });
    expect(l2Argv("cargo-clippy")).toEqual({ cmd: "cargo", args: ["clippy", "--", "-D", "warnings"] });
    expect(l2Argv("prettier")).toEqual({ cmd: "prettier", args: ["--check", "."] });
    expect(l2Argv("gofmt")).toEqual({ cmd: "gofmt", args: ["-l", "."] });
    expect(l2Argv("ruff")).toEqual({ cmd: "ruff", args: ["check", "."] });
    expect(l2Argv("eslint")).toEqual({ cmd: "eslint", args: ["."] });
  });

  describe("pyproject.toml triggers ruff only with a [tool.ruff] table", () => {
    it("bare pyproject.toml does not trigger ruff", () => {
      const dir = makeTmp({ "pyproject.toml": '[project]\nname = "x"\n' });
      expect(detectL2Tools(dir)).not.toContain("ruff");
    });

    it("pyproject.toml with [tool.ruff] triggers ruff", () => {
      const dir = makeTmp({ "pyproject.toml": "[tool.ruff]\nline-length = 100\n" });
      expect(detectL2Tools(dir)).toContain("ruff");
    });

    it("pyproject.toml with only [tool.ruff.lint] triggers ruff", () => {
      const dir = makeTmp({ "pyproject.toml": '[tool.ruff.lint]\nselect = ["E"]\n' });
      expect(detectL2Tools(dir)).toContain("ruff");
    });
  });

  describe("only regular files count as markers", () => {
    it("directories named like markers do not trigger", () => {
      const dir = makeTmp({}, ["Cargo.toml", "package.json", ".prettierrc", ".eslintrc.json", "ruff.toml", "go.mod"]);
      expect(detectL2Tools(dir)).toEqual([]);
    });

    it("a pyproject.toml directory does not trigger ruff", () => {
      const dir = makeTmp({}, ["pyproject.toml"]);
      expect(detectL2Tools(dir)).not.toContain("ruff");
    });
  });
});

describe("runL2 behavior", () => {
  it("missing binary (ENOENT, stubbed spawner) over a go.mod-only dir → []", async () => {
    const calls: string[] = [];
    const spawn = async (cmd: string): Promise<ToolFailure> => {
      calls.push(cmd);
      return { code: "ENOENT", signal: null, output: "" };
    };
    expect(await runL2("tests/fixtures/go", spawn)).toEqual([]);
    expect(calls).toEqual(["gofmt", "go"]);
  });

  it("missing binary (empty PATH, real spawner) over a go.mod-only dir → []", async () => {
    const emptyBin = makeTmp();
    process.env.PATH = emptyBin;
    expect(await runL2("tests/fixtures/go")).toEqual([]);
  });

  it("fake tool exiting non-zero → exactly one warning finding with rule = tool name", async () => {
    const bin = makeTmp({ gofmt: "#!/bin/sh\necho 'main.go is not gofmt-clean' >&2\nexit 3\n" });
    chmodSync(join(bin, "gofmt"), 0o755);
    process.env.PATH = bin; // `go` is absent here → ENOENT → skipped
    const findings = await runL2("tests/fixtures/go");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: "warning", file: "", rule: "gofmt" });
    expect(findings[0].message).toContain("reported issues (exit 3)");
    expect(findings[0].message).toContain("main.go is not gofmt-clean");
  });

  it("tool killed by a signal → message names the signal, not an exit code", async () => {
    const bin = makeTmp({ gofmt: "#!/bin/sh\nkill -9 $$\n" });
    chmodSync(join(bin, "gofmt"), 0o755);
    process.env.PATH = bin;
    const findings = await runL2("tests/fixtures/go");
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe("gofmt");
    expect(findings[0].message).toContain("killed by signal SIGKILL");
    expect(findings[0].message).not.toContain("reported issues");
  });

  it("non-executable binary (EACCES) → message names the errno, not an exit code", async () => {
    const bin = makeTmp({ gofmt: "not a program\n" });
    chmodSync(join(bin, "gofmt"), 0o644);
    process.env.PATH = bin;
    const findings = await runL2("tests/fixtures/go");
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe("gofmt");
    expect(findings[0].message).toContain("could not run (EACCES)");
  });

  it("clean run (exit 0) → tool invoked via the seam, yields no findings", async () => {
    // Spawner returns undefined === exit 0. Recording the call proves the tool was
    // actually invoked (not silently skipped as ENOENT).
    const calls: Array<{ cmd: string; args: string[]; cwd: string }> = [];
    const spawn = async (cmd: string, args: string[], cwd: string): Promise<ToolFailure | undefined> => {
      calls.push({ cmd, args, cwd });
      return undefined;
    };
    expect(await runL2("tests/fixtures/go", spawn)).toEqual([]);
    expect(calls).toEqual([
      { cmd: "gofmt", args: ["-l", "."], cwd: "tests/fixtures/go" },
      { cmd: "go", args: ["vet", "./..."], cwd: "tests/fixtures/go" },
    ]);
  });
});
