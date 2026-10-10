import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export interface FileDiff {
  file: string;
  hunks: string;
  truncated: boolean;
  /** Decided by git (binary diff). Never guess from extension. */
  binary?: boolean;
  /** Bytes on disk (stat). The large-file rule uses this, never hunks.length. */
  size?: number;
}

/** Lockfile basenames (any ecosystem). Prompt-filtered only. */
export const LOCKFILES: ReadonlySet<string> = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "go.sum",
  "Gemfile.lock",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "composer.lock",
  "pubspec.lock",
  "Podfile.lock",
  "packages.lock.json",
  "gradle.lockfile",
  "flake.lock",
]);

/**
 * PROMPT-LLM ONLY. Drops lockfiles, minified JS, source maps and binaries.
 * L0 must run on the UNFILTERED list first (binary note / lockfile-without-manifest).
 */
export function filterForPrompt(files: FileDiff[]): FileDiff[] {
  return files.filter((f) => {
    if (f.binary === true) return false;
    if (LOCKFILES.has(basename(f.file))) return false;
    if (f.file.endsWith(".min.js")) return false;
    if (f.file.endsWith(".map")) return false;
    return true;
  });
}

/**
 * Parses `git diff --name-status -R` (`R<score>\told\tnew`) and
 * `rename from` / `rename to` headers. Findings always use newPath.
 */
export function parseRename(nameStatus: string): { oldPath: string; newPath: string }[] {
  const out: { oldPath: string; newPath: string }[] = [];
  let pendingFrom: string | undefined;
  for (const raw of nameStatus.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const tab = /^R\d*\t([^\t]+)\t([^\t]+)$/.exec(line);
    if (tab) {
      out.push({ oldPath: tab[1], newPath: tab[2] });
      continue;
    }
    if (line.startsWith("rename from ")) {
      pendingFrom = line.slice("rename from ".length);
      continue;
    }
    if (line.startsWith("rename to ") && pendingFrom !== undefined) {
      out.push({ oldPath: pendingFrom, newPath: line.slice("rename to ".length) });
      pendingFrom = undefined;
    }
  }
  return out;
}

const TRUNC_NOTE = "\n[... truncated ...]\n";

/**
 * Concatenates per-file sections, capping each at `perFile` chars and the
 * whole text at `maxChars`. Files that do not fit the global budget are
 * recorded in `skipped` (by file path) instead of included.
 */
export function truncateDiff(
  files: FileDiff[],
  maxChars: number,
  perFile: number,
): { text: string; skipped: string[] } {
  const parts: string[] = [];
  const skipped: string[] = [];
  let total = 0;
  for (const f of files) {
    let section = `--- ${f.file}\n${f.hunks}\n`;
    if (section.length > perFile) {
      section = section.slice(0, Math.max(0, perFile - TRUNC_NOTE.length)) + TRUNC_NOTE;
    }
    if (total + section.length > maxChars) {
      skipped.push(f.file);
      continue;
    }
    parts.push(section);
    total += section.length;
  }
  return { text: parts.join(""), skipped };
}

export interface PrMeta {
  pr_number: number;
  head_sha: string;
  base_sha: string;
  head_repo_full_name: string;
  is_fork: boolean;
}

const PR_META_FILE = "pr-meta.json";

export function writePrMeta(m: PrMeta, dir: string): void {
  writeFileSync(join(dir, PR_META_FILE), JSON.stringify(m, null, 2) + "\n", "utf8");
}

/** Returns undefined when no pr-meta file exists; throws when it is malformed. */
export function readPrMeta(dir: string): PrMeta | undefined {
  const path = join(dir, PR_META_FILE);
  if (!existsSync(path)) return undefined;
  const v = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  if (
    typeof v.pr_number !== "number" ||
    typeof v.head_sha !== "string" ||
    typeof v.base_sha !== "string" ||
    typeof v.head_repo_full_name !== "string" ||
    typeof v.is_fork !== "boolean"
  ) {
    throw new Error(`Invalid ${PR_META_FILE} in ${dir}`);
  }
  return {
    pr_number: v.pr_number,
    head_sha: v.head_sha,
    base_sha: v.base_sha,
    head_repo_full_name: v.head_repo_full_name,
    is_fork: v.is_fork,
  };
}
