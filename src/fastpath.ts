import { basename } from "node:path";
import { isLockfile, type FileDiff } from "./diff.js";

export interface Finding {
  severity: "info" | "warning" | "high";
  file: string;
  line?: number;
  rule: string;
  message: string;
  suggestion?: string;
}

const LARGE_FILE_BYTES = 500 * 1024;
const TODO_RE = /\b(TODO|FIXME|XXX)\b/;

/** Filename-level sensitive-path rules (basename match). */
function isSensitivePath(file: string): boolean {
  const name = basename(file);
  if (name === "id_rsa") return true;
  if (name.endsWith(".pem")) return true;
  if (name === ".env" || name.startsWith(".env.")) return true;
  return false;
}

/**
 * Deterministic fast-path checks. Runs on the UNFILTERED file list.
 * `hasManifestFor(lockfile)` is the caller's per-ecosystem lookup; when omitted,
 * every lockfile is treated as lacking a manifest (conservative).
 */
export function runL0(
  files: FileDiff[],
  o: { hasManifestFor?: (lockfile: string) => boolean } = {},
): Finding[] {
  const hasManifestFor = o.hasManifestFor ?? (() => false);
  const out: Finding[] = [];

  for (const f of files) {
    if (isSensitivePath(f.file)) {
      out.push({
        severity: "high",
        file: f.file,
        rule: "sensitive-path",
        message: `Sensitive file path changed: ${f.file}`,
      });
    }

    if ((f.size ?? 0) > LARGE_FILE_BYTES) {
      out.push({
        severity: "warning",
        file: f.file,
        rule: "large-file",
        message: `File larger than 500KB: ${f.file}`,
      });
    }

    if (f.binary === true || (f.hunks === "" && (f.size ?? 0) > 0)) {
      out.push({
        severity: "info",
        file: f.file,
        rule: "binary-note",
        message: `Binary or non-text change, not reviewed: ${f.file}`,
      });
    }

    if (isLockfile(f.file) && !hasManifestFor(basename(f.file))) {
      out.push({
        severity: "warning",
        file: f.file,
        rule: "lockfile-without-manifest",
        message: `Lockfile changed without its manifest: ${f.file}`,
      });
    }

    const lines = f.hunks.split("\n");
    lines.forEach((text, i) => {
      if (TODO_RE.test(text)) {
        out.push({
          severity: "info",
          file: f.file,
          line: i + 1,
          rule: "todo-marker",
          message: `TODO/FIXME/XXX marker: ${text.trim()}`,
        });
      }
    });
  }

  return out;
}
