import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getInputs, parseFailLevel } from "../src/inputs.js";

const INPUT_NAMES = [
  "github_token",
  "llm_provider",
  "llm_base_url",
  "llm_api_style",
  "llm_path",
  "llm_model",
  "llm_api_key",
  "llm_temperature",
  "llm_top_p",
  "pr_number",
  "fail_level",
  "max_diff_chars",
  "post_comment",
  "timeout_seconds",
  "llm_max_tokens",
];

let saved: Record<string, string | undefined> = {};

function setInputs(values: Record<string, string>): void {
  for (const name of INPUT_NAMES) {
    const key = `INPUT_${name.toUpperCase()}`;
    if (name in values) process.env[key] = values[name];
    else delete process.env[key];
  }
}

beforeEach(() => {
  saved = {};
  for (const name of INPUT_NAMES) {
    const key = `INPUT_${name.toUpperCase()}`;
    saved[key] = process.env[key];
  }
  setInputs({});
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("getInputs defaults", () => {
  it("defaults match spec", () => {
    const i = getInputs();
    expect(i.llmProvider).toBe("openai");
    expect(i.llmApiStyle).toBe("auto");
    expect(i.failLevel).toBe("warning");
    expect(i.maxDiffChars).toBe(60000);
    expect(i.timeoutSeconds).toBe(90);
    expect(i.llmMaxTokens).toBe(2000);
    expect(i.postComment).toBe(true);
    expect(i.llmTemperature).toBeUndefined();
    expect(i.llmTopP).toBeUndefined();
    expect(i.prNumber).toBeNull();
  });
});

describe("parseFailLevel", () => {
  it("accepts none|warning|high", () => {
    expect(parseFailLevel("none")).toBe("none");
    expect(parseFailLevel("warning")).toBe("warning");
    expect(parseFailLevel("high")).toBe("high");
  });

  it("rejects bad fail_level naming the input", () => {
    expect(() => parseFailLevel("block")).toThrow(/fail_level/);
  });
});

describe("getInputs parsing", () => {
  it("rejects bad fail_level via getInputs", () => {
    setInputs({ fail_level: "block" });
    expect(() => getInputs()).toThrow(/fail_level/);
  });

  it("parses pr_number when non-empty", () => {
    setInputs({ pr_number: "42" });
    expect(getInputs().prNumber).toBe(42);
  });

  it("rejects non-numeric pr_number", () => {
    setInputs({ pr_number: "abc" });
    expect(() => getInputs()).toThrow(/pr_number/);
  });

  it("rejects unknown llm_provider naming the input", () => {
    setInputs({ llm_provider: "bogus" });
    expect(() => getInputs()).toThrow(/llm_provider/);
  });

  it("accepts all 10 llm_provider values", () => {
    const providers = [
      "openai",
      "anthropic",
      "google",
      "groq",
      "mistral",
      "openrouter",
      "ollama",
      "opencode-zen",
      "opencode-go",
      "custom",
    ];
    for (const p of providers) {
      setInputs({ llm_provider: p });
      expect(getInputs().llmProvider).toBe(p);
    }
  });

  it("rejects unknown llm_api_style naming the input", () => {
    setInputs({ llm_api_style: "chat" });
    expect(() => getInputs()).toThrow(/llm_api_style/);
  });

  it("accepts all 6 llm_api_style values", () => {
    const styles = [
      "auto",
      "openai-chat",
      "openai-responses",
      "anthropic-messages",
      "google-models",
      "custom-path",
    ];
    for (const s of styles) {
      setInputs({ llm_api_style: s });
      expect(getInputs().llmApiStyle).toBe(s);
    }
  });

  it("parses llm_temperature and llm_top_p only when non-empty", () => {
    setInputs({ llm_temperature: "0.5", llm_top_p: "0.9" });
    const i = getInputs();
    expect(i.llmTemperature).toBe(0.5);
    expect(i.llmTopP).toBe(0.9);
  });

  it("rejects non-numeric llm_temperature naming the input", () => {
    setInputs({ llm_temperature: "warm" });
    expect(() => getInputs()).toThrow(/llm_temperature/);
  });

  it("rejects non-numeric llm_top_p naming the input", () => {
    setInputs({ llm_top_p: "high" });
    expect(() => getInputs()).toThrow(/llm_top_p/);
  });

  it("coerces integer inputs", () => {
    setInputs({ max_diff_chars: "1000", timeout_seconds: "30", llm_max_tokens: "500" });
    const i = getInputs();
    expect(i.maxDiffChars).toBe(1000);
    expect(i.timeoutSeconds).toBe(30);
    expect(i.llmMaxTokens).toBe(500);
  });

  it("rejects non-integer max_diff_chars naming the input", () => {
    setInputs({ max_diff_chars: "12.5" });
    expect(() => getInputs()).toThrow(/max_diff_chars/);
  });

  it("parses post_comment false", () => {
    setInputs({ post_comment: "false" });
    expect(getInputs().postComment).toBe(false);
  });

  it("rejects invalid post_comment naming the input", () => {
    setInputs({ post_comment: "yes" });
    expect(() => getInputs()).toThrow(/post_comment/);
  });
});
