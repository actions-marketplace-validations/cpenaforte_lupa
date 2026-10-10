import { execFile } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Finding } from "./fastpath.js";

export interface L2Tool {
  name: string;
  cmd: string;
  args: string[];
}

/** Failure details of a check-only run. `undefined` from a Spawner means success. */
export interface ToolFailure {
  /** Numeric exit code, errno string (e.g. "ENOENT", "EACCES"), or null. */
  code: number | string | null;
  /** Terminating signal when killed (e.g. "SIGKILL"), else null. */
  signal: string | null;
  /** Combined stdout+stderr. */
  output: string;
}

/** Injectable process runner. Tests stub it; production uses `execTool`. */
export type Spawner = (cmd: string, args: string[], cwd: string) => Promise<ToolFailure | undefined>;

const MAX_BUFFER = 16 * 1024 * 1024;

/** Regular files directly inside `dir` (directories and unreadable entries are excluded). */
function listFiles(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => {
    try {
      return statSync(join(dir, n)).isFile();
    } catch {
      return false;
    }
  });
}

/** `pyproject.toml` only counts as a ruff config when it declares a [tool.ruff] table or subtable. */
function pyprojectHasRuff(dir: string): boolean {
  try {
    return /^\s*\[tool\.ruff(\.[^\]]*)?\]/m.test(readFileSync(join(dir, "pyproject.toml"), "utf8"));
  } catch {
    return false;
  }
}

/**
 * Detect native linters by config-file presence. Returns tool names in a stable order.
 * Only regular files count; a directory named like a marker does not trigger.
 * - Cargo.toml → cargo-fmt, cargo-clippy
 * - package.json, .prettierrc*, prettier.config.* → prettier (config may live in package.json)
 * - .eslintrc*, eslint.config.* → eslint
 * - ruff.toml, or pyproject.toml containing [tool.ruff] (or any [tool.ruff.*]) → ruff
 * - go.mod → gofmt, go vet
 */
export function detectL2Tools(dir: string): string[] {
  const files = listFiles(dir);
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

/** Real runner: `execFile` with args array (no shell). Resolves `undefined` on success. */
export const execTool: Spawner = (cmd, args, cwd) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd, maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
      if (!err) return resolve(undefined);
      const e = err as NodeJS.ErrnoException & { signal?: NodeJS.Signals | null };
      const code = typeof e.code === "string" || typeof e.code === "number" ? e.code : null;
      resolve({
        code,
        signal: e.signal ?? null,
        output: `${String(stdout)}${String(stderr)}`,
      });
    });
  });

/** Human-readable failure reason: signal kill, errno (e.g. EACCES), or non-zero exit. */
function describeFailure(name: string, f: ToolFailure): string {
  if (f.signal) return `${name} killed by signal ${f.signal}`;
  if (typeof f.code === "string") return `${name} could not run (${f.code})`;
  if (typeof f.code === "number") return `${name} reported issues (exit ${f.code})`;
  return `${name} exited abnormally`;
}

/** Run one check-only command. `undefined` when clean or when the binary is missing (ENOENT). */
async function runOne(name: string, dir: string, spawn: Spawner): Promise<Finding | undefined> {
  const { cmd, args } = l2Argv(name);
  const failure = await spawn(cmd, args, dir);
  if (!failure) return undefined;
  // Binary not installed on this runner: skip silently.
  if (failure.code === "ENOENT") return undefined;
  const detail = failure.output.trim().split("\n").slice(0, 5).join("\n");
  return {
    severity: "warning",
    file: "",
    rule: name,
    message: `${describeFailure(name, failure)}${detail ? `:\n${detail}` : ""}`,
  };
}

/**
 * Run every detected L2 tool in `dir`, sequentially. Clean or missing binary → no finding;
 * non-zero exit, signal kill, or other errno → one warning finding per tool.
 * `spawn` is injectable for tests; defaults to the real `execTool`.
 */
export async function runL2(dir: string, spawn: Spawner = execTool): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const name of detectL2Tools(dir)) {
    const f = await runOne(name, dir, spawn);
    if (f) findings.push(f);
  }
  return findings;
}
