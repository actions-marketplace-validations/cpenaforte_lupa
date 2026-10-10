import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding } from "./fastpath.js";

export interface L2Tool {
  name: string;
  cmd: string;
  args: string[];
}

const MAX_BUFFER = 16 * 1024 * 1024;

/** Filenames present in `dir` (empty when the directory cannot be read). */
function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** `pyproject.toml` only counts as a ruff config when it declares a [tool.ruff] table. */
function pyprojectHasRuff(dir: string): boolean {
  try {
    return /^\s*\[tool\.ruff(\.[^\]]*)?\]/m.test(readFileSync(join(dir, "pyproject.toml"), "utf8"));
  } catch {
    return false;
  }
}

/**
 * Detect native linters by config-file presence. Returns tool names in a stable order.
 * - Cargo.toml → cargo-fmt, cargo-clippy
 * - package.json, .prettierrc*, prettier.config.* → prettier (config may live in package.json)
 * - .eslintrc*, eslint.config.* → eslint
 * - ruff.toml, or pyproject.toml containing [tool.ruff] → ruff
 * - go.mod → gofmt, go vet
 */
export function detectL2Tools(dir: string): string[] {
  const files = listDir(dir);
  const has = (name: string) => files.includes(name);
  const hasPrefix = (prefix: string) => files.some((f) => f.startsWith(prefix));
  const out: string[] = [];

  if (has("Cargo.toml")) out.push("cargo-fmt", "cargo-clippy");
  if (has("package.json") || hasPrefix(".prettierrc") || hasPrefix("prettier.config.")) out.push("prettier");
  if (hasPrefix(".eslintrc") || hasPrefix("eslint.config.")) out.push("eslint");
  if (has("ruff.toml") || (has("pyproject.toml") && pyprojectHasRuff(dir))) out.push("ruff");
  if (has("go.mod")) out.push("gofmt", "go vet");

  return out;
}

/**
 * Check-only argv for an L2 tool. Never the mutating form (no `--write`, no `fmt` without `--check`).
 * `go vet` is split into cmd `go` + args, never executed as a single file name.
 */
export function l2Argv(name: string): { cmd: string; args: string[] } {
  switch (name) {
    case "cargo-fmt":
      return { cmd: "cargo", args: ["fmt", "--check"] };
    case "cargo-clippy":
      return { cmd: "cargo", args: ["clippy", "--", "-D", "warnings"] };
    case "prettier":
      return { cmd: "prettier", args: ["--check", "."] };
    case "eslint":
      return { cmd: "eslint", args: ["."] };
    case "ruff":
      return { cmd: "ruff", args: ["check", "."] };
    case "gofmt":
      return { cmd: "gofmt", args: ["-l", "."] };
    case "go vet":
      return { cmd: "go", args: ["vet", "./..."] };
    default:
      throw new Error(`unknown L2 tool: ${name}`);
  }
}

/** Run one check-only command. Resolves to `undefined` when clean or when the binary is missing. */
function runOne(name: string, dir: string): Promise<Finding | undefined> {
  const { cmd, args } = l2Argv(name);
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: dir, maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
      if (!err) return resolve(undefined);
      const e = err as NodeJS.ErrnoException;
      // Binary not installed on this runner: skip silently.
      if (e.code === "ENOENT") return resolve(undefined);
      const code = typeof e.code === "number" ? e.code : null;
      const detail = `${String(stdout)}${String(stderr)}`.trim().split("\n").slice(0, 5).join("\n");
      resolve({
        severity: "warning",
        file: "",
        rule: name,
        message: `${name} reported issues (exit ${code ?? "abnormally"})${detail ? `:\n${detail}` : ""}`,
      });
    });
  });
}

/** Run every detected L2 tool in `dir`. Non-zero exit → one warning finding per tool. */
export async function runL2(dir: string): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const name of detectL2Tools(dir)) {
    const f = await runOne(name, dir);
    if (f) findings.push(f);
  }
  return findings;
}
