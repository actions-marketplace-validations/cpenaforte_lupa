import * as fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("README", () => {
  it("readme covers providers costs fork dry-run and levels", () => {
    const r = fs.readFileSync("README.md", "utf8");
    for (const s of [
      "opencode-zen",
      "opencode-go",
      "workflow_run",
      "post_comment",
      "fail_level",
      "typical",
      "peak/off-peak",
      "Zen vs direto",
      "v1",
      "v2",
      "fork",
      "App",
      "two-workflow",
      "artifact",
      "dry-run",
      "REQUEST_CHANGES",
    ]) {
      expect(r).toContain(s);
    }
  });

  it("readme documents the exit-code gate and the fork L2 skip", () => {
    const r = fs.readFileSync("README.md", "utf8");
    expect(r).toContain("exit-code");
    expect(r).toContain("/proc");
    expect(r).toContain("LLM_API_KEY");
    expect(r).toContain("docs/workflow-template.yml");
    expect(r).toContain("docs/workflow-template-privileged.yml");
  });
});
