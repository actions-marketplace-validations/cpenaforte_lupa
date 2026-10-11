import { describe, it, expect } from "vitest";
import { AGENT_LIMITS } from "../src/agent-types.js";
describe("AGENT_LIMITS", () => {
  it("pins the spec caps", () => {
    expect(AGENT_LIMITS).toEqual({
      maxCallsPerTurn: 4, resultBytes: 32768, totalBytes: 131072,
      linkedRepos: 3, cloneMs: 60000, cloneMaxBytes: 209715200,
    });
  });
});
