import type { Finding } from "./fastpath.js";
import type { FailLevel } from "./inputs.js";

export interface InlineComment {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  start_line?: number;
  start_side?: "LEFT" | "RIGHT";
  body: string;
}

export interface ReviewPayload {
  commit_id: string;
  body: string;
  event: "COMMENT" | "REQUEST_CHANGES";
  comments: InlineComment[];
}

/** One commentable diff line. LEFT = old-file line number (deletion); RIGHT = new-file line number. */
export interface HunkLine {
  side: "LEFT" | "RIGHT";
  line: number;
  kind: "add" | "del" | "ctx";
}

/** One unified-diff hunk of a file, with the commentable lines it exposes. */
export interface ParsedHunk {
  file: string;
  lines: HunkLine[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Parses unified-diff hunk text (as stored in FileDiff.hunks) into commentable lines.
 * `-` lines are LEFT (old numbering), `+` and context lines are RIGHT (new numbering).
 * Lines before the first `@@` and `\ No newline` markers are ignored.
 */
export function parseHunks(files: { file: string; hunks: string }[]): ParsedHunk[] {
  const out: ParsedHunk[] = [];
  for (const f of files) {
    let current: ParsedHunk | undefined;
    let oldLine = 0;
    let newLine = 0;
    for (const raw of f.hunks.split("\n")) {
      const header = HUNK_HEADER.exec(raw);
      if (header) {
        oldLine = Number(header[1]);
        newLine = Number(header[2]);
        current = { file: f.file, lines: [] };
        out.push(current);
        continue;
      }
      if (current === undefined || raw === "" || raw.startsWith("\\")) continue;
      const tag = raw[0];
      if (tag === "-") {
        current.lines.push({ side: "LEFT", line: oldLine, kind: "del" });
        oldLine++;
      } else if (tag === "+") {
        current.lines.push({ side: "RIGHT", line: newLine, kind: "add" });
        newLine++;
      } else if (tag === " ") {
        current.lines.push({ side: "RIGHT", line: newLine, kind: "ctx" });
        oldLine++;
        newLine++;
      }
    }
  }
  return out;
}

function keyOf(side: "LEFT" | "RIGHT", line: number): string {
  return `${side}:${line}`;
}

function isValidLine(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1;
}

function formatBody(f: Finding): string {
  let body = `**${f.severity}** [${f.rule}] ${f.message}`;
  if (typeof f.suggestion === "string" && f.suggestion !== "") {
    body += `\n\n\`\`\`suggestion\n${f.suggestion}\n\`\`\``;
  }
  return body;
}

/**
 * Maps findings onto commentable diff lines. A finding becomes an inline comment only when
 * its file and line are both present in the hunks; everything else (repo-level, line-less,
 * off-diff) goes to the general list, which the caller folds into the review body.
 * Prefers RIGHT when a line number exists on both sides. A suggestion pairs start_line /
 * start_side with the contiguous run of same-side change lines ending at the finding's line.
 */
export function mapToComments(
  findings: Finding[],
  hunks: ParsedHunk[],
): { inline: InlineComment[]; general: Finding[] } {
  const index = new Map<string, Map<string, HunkLine>>();
  for (const h of hunks) {
    let byKey = index.get(h.file);
    if (byKey === undefined) {
      byKey = new Map();
      index.set(h.file, byKey);
    }
    for (const l of h.lines) {
      const k = keyOf(l.side, l.line);
      if (!byKey.has(k)) byKey.set(k, l);
    }
  }

  const inline: InlineComment[] = [];
  const general: Finding[] = [];
  for (const f of findings) {
    const byKey = f.file === "" ? undefined : index.get(f.file);
    if (byKey === undefined || !isValidLine(f.line)) {
      general.push(f);
      continue;
    }
    const line = f.line;
    const hit = byKey.get(keyOf("RIGHT", line)) ?? byKey.get(keyOf("LEFT", line));
    if (hit === undefined) {
      general.push(f);
      continue;
    }
    const c: InlineComment = { path: f.file, line, side: hit.side, body: formatBody(f) };
    if (typeof f.suggestion === "string" && f.suggestion !== "" && hit.kind !== "ctx") {
      const changeKind = hit.side === "RIGHT" ? "add" : "del";
      let start = line;
      for (;;) {
        const prev = byKey.get(keyOf(hit.side, start - 1));
        if (prev === undefined || prev.kind !== changeKind) break;
        start--;
      }
      c.start_line = start;
      c.start_side = hit.side;
    }
    inline.push(c);
  }
  return { inline, general };
}

/** `high` requests changes only on high-severity evidence; `none` and `warning` never do. */
export function eventFor(failLevel: FailLevel, findings: Finding[]): "COMMENT" | "REQUEST_CHANGES" {
  if (failLevel === "high" && findings.some((f) => f.severity === "high")) return "REQUEST_CHANGES";
  return "COMMENT";
}

/**
 * Exit code for the fail_level gate. `none` never fails; `warning` fails on any non-info
 * finding (info-only never fails); `high` fails only on high-severity evidence.
 */
export function exitFor(failLevel: FailLevel, findings: Finding[]): number {
  if (failLevel === "none") return 0;
  if (failLevel === "warning") return findings.some((f) => f.severity !== "info") ? 2 : 0;
  return findings.some((f) => f.severity === "high") ? 1 : 0;
}

const FALLBACK_SUMMARY = "pr-reviewer: review complete.";

function locate(f: Finding): string {
  if (f.file === "") return "(repository)";
  return isValidLine(f.line) ? `${f.file}:${f.line}` : f.file;
}

/** Review body: summary plus any findings that could not be placed inline. Never empty. */
export function buildBody(general: Finding[], summary: string): string {
  const head = summary.trim() === "" ? FALLBACK_SUMMARY : summary.trim();
  if (general.length === 0) return head;
  const items = general.map((f) => `- **${f.severity}** ${locate(f)} [${f.rule}] ${f.message}`);
  return `${head}\n\n**Findings not placed inline:**\n${items.join("\n")}`;
}
