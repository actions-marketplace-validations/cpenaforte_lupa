import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  filterForPrompt,
  truncateDiff,
  parseRename,
  writePrMeta,
  readPrMeta,
  type FileDiff,
  type PrMeta,
} from "../src/diff.js";

// Local fixture (do NOT import from review.js — Task 10 owns it).
function hunksFor(file: string): { file: string; header: string; body: string }[] {
  return [{ file, header: "@@ -1 +1 @@", body: "-a\n+b\n" }];
}

describe("diff", () => {
  it("prompt filter drops lock/minified/map/binaries from prompt (L0 runs unfiltered)", () => {
    const F = (file: string, binary = false) => ({ file, hunks: "", truncated: false, binary });
    expect(
      filterForPrompt([F("src/a.ts"), F("package-lock.json"), F("dist/b.min.js"), F("a.map")]).map(
        (f) => f.file,
      ),
    ).toEqual(["src/a.ts"]);
    expect(filterForPrompt([F("img.png", true), F("package-lock.json")])).toEqual([]);
    const { text } = truncateDiff(
      [{ file: "big.ts", hunks: "x".repeat(20000), truncated: false }],
      60000,
      8000,
    );
    expect(text.length).toBeLessThanOrEqual(8000);
  });

  it("follows renames via parseRename (new path), both formats", () => {
    const r = parseRename("R100\told/a.ts\tnew/a.ts\nM\tsrc/b.ts");
    expect(r).toEqual([{ oldPath: "old/a.ts", newPath: "new/a.ts" }]);
    const h = parseRename("rename from old/c.ts\nrename to new/c.ts\n");
    expect(h).toEqual([{ oldPath: "old/c.ts", newPath: "new/c.ts" }]);
    expect(hunksFor("new/a.ts")[0].file).toBe("new/a.ts");
  });

  it("truncateDiff respects global maxChars and records skipped files", () => {
    const files: FileDiff[] = [
      { file: "a.ts", hunks: "y".repeat(400), truncated: false },
      { file: "b.ts", hunks: "y".repeat(400), truncated: false },
      { file: "c.ts", hunks: "y".repeat(400), truncated: false },
    ];
    const { text, skipped } = truncateDiff(files, 1000, 8000);
    expect(text.length).toBeLessThanOrEqual(1000);
    expect(skipped).toEqual(["c.ts"]);
    expect(text).toContain("a.ts");
    expect(text).toContain("b.ts");
  });

  it("filterForPrompt keeps hunks and files untouched on the survivors", () => {
    const f: FileDiff = { file: "src/x.ts", hunks: "@@ keep @@", truncated: true, size: 12 };
    expect(filterForPrompt([f])).toEqual([f]);
  });

  it("parseRename ignores non-rename lines and returns [] when none", () => {
    expect(parseRename("M\ta.ts\nA\tb.ts\n")).toEqual([]);
    expect(parseRename("")).toEqual([]);
  });

  it("pr-meta write/read roundtrip", () => {
    const dir = mkdtempSync(join(tmpdir(), "prmeta-"));
    try {
      const m: PrMeta = {
        pr_number: 42,
        head_sha: "a".repeat(40),
        base_sha: "b".repeat(40),
        head_repo_full_name: "org/fork",
        is_fork: true,
      };
      writePrMeta(m, dir);
      expect(readPrMeta(dir)).toEqual(m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("readPrMeta returns undefined when no pr-meta file exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "prmeta-"));
    try {
      expect(readPrMeta(dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
