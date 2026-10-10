import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectL2Tools, l2Argv } from "../src/l2.js";

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

  describe("pyproject.toml triggers ruff only with [tool.ruff]", () => {
    const withDir = (files: Record<string, string>, fn: (dir: string) => void) => {
      const dir = mkdtempSync(join(tmpdir(), "l2-"));
      try {
        for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
        fn(dir);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    it("bare pyproject.toml does not trigger ruff", () => {
      withDir({ "pyproject.toml": "[project]\nname = \"x\"\n" }, (dir) => {
        expect(detectL2Tools(dir)).not.toContain("ruff");
      });
    });

    it("pyproject.toml with [tool.ruff] triggers ruff", () => {
      withDir({ "pyproject.toml": "[tool.ruff]\nline-length = 100\n" }, (dir) => {
        expect(detectL2Tools(dir)).toContain("ruff");
      });
    });
  });
});
