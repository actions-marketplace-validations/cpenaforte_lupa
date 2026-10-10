import { describe, expect, it } from "vitest";
import { buildBody, eventFor, exitFor, mapToComments, parseHunks } from "../src/review.js";
import type { Finding } from "../src/fastpath.js";

// a.ts: line 3 is a deletion (LEFT 3), line 4 an addition (RIGHT 4); line 99 is outside every hunk.
function hunksFixture() {
  return parseHunks([{ file: "a.ts", hunks: "@@ -3,1 +3,0 @@\n-c\n@@ -10,0 +4,1 @@\n+d\n" }]);
}
// a.ts: 3-line addition range at RIGHT 8-10.
function rangeFixture() {
  return parseHunks([{ file: "a.ts", hunks: "@@ -7,0 +8,3 @@\n+x\n+y\n+z\n" }]);
}
function highFinding(): Finding[] {
  return [{ severity: "high", file: "a.ts", line: 4, rule: "r", message: "m" }];
}

describe("mapToComments", () => {
  it("deletion maps LEFT, addition RIGHT, off-diff goes general", () => {
    const del = mapToComments([{ severity: "high", file: "a.ts", line: 3, rule: "r", message: "m" }], hunksFixture());
    expect(del.inline[0].side).toBe("LEFT");
    expect("position" in (del.inline[0] as object)).toBe(false);
    expect(del.inline[0].body).toBeTruthy();
    const add = mapToComments([{ severity: "info", file: "a.ts", line: 4, rule: "r", message: "m" }], hunksFixture());
    expect(add.inline[0].side).toBe("RIGHT");
    const off = mapToComments([{ severity: "info", file: "a.ts", line: 99, rule: "r", message: "m" }], hunksFixture());
    expect(off.inline).toEqual([]);
    expect(off.general.map((f) => f.file)).toContain("a.ts");
  });

  it("multi-line pairs start_line+start_side", () => {
    const r = mapToComments([{ severity: "warning", file: "a.ts", line: 10, rule: "r", message: "m", suggestion: "s" }], rangeFixture());
    expect(r.inline[0].start_line).toBe(8);
    expect(r.inline[0].start_side).toBe("RIGHT");
    expect(r.inline[0].line).toBe(10);
  });

  it("single-line finding without suggestion carries no start fields", () => {
    const r = mapToComments([{ severity: "warning", file: "a.ts", line: 10, rule: "r", message: "m" }], rangeFixture());
    expect(r.inline[0].start_line).toBeUndefined();
    expect(r.inline[0].start_side).toBeUndefined();
  });

  it("repo-level (file \"\") and line-less findings go general", () => {
    const r = mapToComments(
      [
        { severity: "warning", file: "", rule: "r", message: "repo" },
        { severity: "info", file: "a.ts", rule: "r", message: "no line" },
      ],
      hunksFixture(),
    );
    expect(r.inline).toEqual([]);
    expect(r.general).toHaveLength(2);
  });

  it("defensively treats null-ish line/suggestion as absent", () => {
    const f = { severity: "info", file: "a.ts", line: null, suggestion: null, rule: "r", message: "m" } as unknown as Finding;
    const r = mapToComments([f], hunksFixture());
    expect(r.inline).toEqual([]);
    expect(r.general).toHaveLength(1);
  });
});

describe("parseHunks", () => {
  it("assigns side per line and ignores the no-newline marker", () => {
    const h = parseHunks([{ file: "b.ts", hunks: "@@ -1,2 +1,2 @@\n ctx\n-old\n+new\n\\ No newline at end of file\n" }]);
    expect(h).toHaveLength(1);
    expect(h[0].file).toBe("b.ts");
    expect(h[0].lines).toEqual([
      { side: "RIGHT", line: 1, kind: "ctx" },
      { side: "LEFT", line: 2, kind: "del" },
      { side: "RIGHT", line: 2, kind: "add" },
    ]);
  });
});

describe("buildBody", () => {
  it("is never empty", () => {
    expect(buildBody([], "").length).toBeGreaterThan(0);
    expect(buildBody([], "   ").length).toBeGreaterThan(0);
  });

  it("appends general findings to the summary", () => {
    const body = buildBody([{ severity: "warning", file: "a.ts", line: 99, rule: "r", message: "off diff" }], "Summary");
    expect(body).toContain("Summary");
    expect(body).toContain("off diff");
  });
});

describe("eventFor", () => {
  it("warning never requests changes; none never blocks; never APPROVE", () => {
    expect(eventFor("warning", highFinding())).toBe("COMMENT");
    expect(eventFor("none", highFinding())).toBe("COMMENT");
    expect(eventFor("high", [])).toBe("COMMENT");
    expect(eventFor("high", highFinding())).toBe("REQUEST_CHANGES");
  });

  it("high without high evidence is COMMENT", () => {
    expect(eventFor("high", [{ severity: "warning", file: "a", rule: "r", message: "m" }])).toBe("COMMENT");
  });
});

describe("exitFor", () => {
  it("exit codes pinned: none 0, warning 2 only above info, high 1 with evidence", () => {
    expect(exitFor("none", highFinding())).toBe(0);
    expect(exitFor("warning", [])).toBe(0);
    expect(exitFor("warning", [{ severity: "info", file: "a", rule: "r", message: "m" }])).toBe(0);
    expect(exitFor("warning", highFinding())).toBe(2);
    expect(exitFor("high", [{ severity: "warning", file: "a", rule: "r", message: "m" }])).toBe(0);
    expect(exitFor("high", [{ severity: "info", file: "a", rule: "r", message: "m" }])).toBe(0);
    expect(exitFor("high", highFinding())).toBe(1);
    expect(exitFor("high", [])).toBe(0);
  });
});
