import { describe, it, expect, vi, afterEach } from "vitest";
import {
  resolveEndpoint,
  UnsupportedModelError,
  validateModelExists,
  NON_CHAT,
} from "../src/providers.js";

const base = { llmBaseUrl: "", llmApiStyle: "auto", llmPath: "", llmApiKey: "k", prNumber: 1 } as const;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("resolveEndpoint", () => {
  it("base and path are separate for zen", () => {
    const r = resolveEndpoint({ ...base, llmProvider: "opencode-zen", llmModel: "glm-5.3-flash" });
    expect(r.baseUrl).toBe("https://opencode.ai/zen/v1");
    expect(r.path).toBe("/chat/completions");
  });

  it("zen qwen3.8-max resolves chat, go qwen3.8-max throws", () => {
    expect(resolveEndpoint({ ...base, llmProvider: "opencode-zen", llmModel: "qwen3.8-max" }).path).toBe("/chat/completions");
    expect(() => resolveEndpoint({ ...base, llmProvider: "opencode-go", llmModel: "qwen3.8-max" })).toThrow(UnsupportedModelError);
  });

  it("zen sends no session header, go does", () => {
    const z = resolveEndpoint({ ...base, llmProvider: "opencode-zen", llmModel: "deepseek-v4.1-flash" });
    expect(z.headers["User-Agent"]).toContain("pr-reviewer");
    expect(z.headers["x-opencode-session"]).toBeUndefined();
    const g = resolveEndpoint({ ...base, llmProvider: "opencode-go", llmModel: "glm-5.3-flash" });
    expect(g.headers["x-opencode-session"]).toBe("pr-1");
  });

  it("matrix: documented chat models resolve, non-chat fail-fast", () => {
    for (const m of ["deepseek-v4.1-flash","deepseek-v4-pro","deepseek-v4-flash","glm-5.3-flash","glm-5.3","glm-5.2","kimi-k3","kimi-k2.7-code","kimi-k2.6","minimax-m3","minimax-m2.7","mistral-large-4","qwen3.8-max","big-pickle","space-bunny-free","mimo-v2.6-flash-free"]) {
      expect(resolveEndpoint({ ...base, llmProvider: "opencode-zen", llmModel: m }).path).toBe("/chat/completions");
    }
    expect(() => resolveEndpoint({ ...base, llmProvider: "opencode-zen", llmModel: "gpt-6-luna" })).toThrow(UnsupportedModelError);
    expect(() => resolveEndpoint({ ...base, llmProvider: "opencode-zen", llmModel: "claude-sonnet-5-5" })).toThrow(UnsupportedModelError);
  });

  it("zen non-chat fail-fast covers v2 list", () => {
    for (const m of ["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra", "grok-4.7", "grok-4.6", "claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "qwen3.7-max", "qwen3.7-plus", "gemini-3.8-flash", "gemini-3.5-flash-lite"]) {
      expect(() => resolveEndpoint({ ...base, llmProvider: "opencode-zen", llmModel: m })).toThrow(UnsupportedModelError);
    }
  });

  it("go chat models resolve, go non-chat fail-fast", () => {
    for (const m of ["glm-5.3-flash", "glm-5.3", "glm-5.2", "kimi-k3", "kimi-k2.7-code", "kimi-k2.6", "deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4.1-flash", "deepseek-v4-flash-vision-exp", "mimo-v2.6-flash", "mimo-v2.5", "mimo-v2.6-pro", "hy4-preview", "hy3", "longcat-2.0", "space-bunny"]) {
      expect(resolveEndpoint({ ...base, llmProvider: "opencode-go", llmModel: m }).path).toBe("/chat/completions");
    }
    for (const m of ["grok-4.7", "grok-4.6", "gpt-6-luna", "gpt-5.6-luna", "gpt-6.1-sol", "gpt-6-astra", "muse-spark-1.3-contributor", "claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "minimax-m3", "minimax-m2.7", "qwen3.8-max", "qwen3.8-flash", "qwen3.7-max", "qwen3.7-plus", "gemini-3.8-flash", "gemini-3.5-flash-lite"]) {
      expect(() => resolveEndpoint({ ...base, llmProvider: "opencode-go", llmModel: m })).toThrow(UnsupportedModelError);
    }
  });

  it("llm_path to non-chat without v2 style throws path-only error", () => {
    expect(() => resolveEndpoint({ ...base, llmProvider: "custom", llmBaseUrl: "https://x", llmModel: "m", llmPath: "/messages" })).toThrow(/path-only/);
  });

  it("explicit v2 api_style throws in v1", () => {
    expect(() => resolveEndpoint({ ...base, llmProvider: "openai", llmModel: "m", llmApiStyle: "anthropic-messages" })).toThrow(UnsupportedModelError);
  });

  it("prNumber null ok, go without number omits session header", () => {
    expect(resolveEndpoint({ ...base, llmProvider: "openai", llmModel: "m", prNumber: null }).headers["x-opencode-session"]).toBeUndefined();
    expect(resolveEndpoint({ ...base, llmProvider: "opencode-go", llmModel: "glm-5.3-flash", prNumber: null }).headers["x-opencode-session"]).toBeUndefined();
    const g = resolveEndpoint({ ...base, llmProvider: "opencode-go", llmModel: "glm-5.3-flash" });
    expect(g.headers["x-opencode-session"]).toBe("pr-1");
  });

  it("NON_CHAT contains only non-chat pairs", () => {
    expect(NON_CHAT.get("opencode-go:qwen3.8-max")).toBe("anthropic-messages");
    expect(NON_CHAT.get("opencode-zen:gpt-6-luna")).toBe("openai-responses");
    expect(NON_CHAT.get("opencode-zen:gemini-3.8-flash")).toBe("google-models");
    expect(NON_CHAT.has("opencode-zen:qwen3.8-max")).toBe(false);
  });
});

describe("validateModelExists", () => {
  it("checks id presence only", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ data: [{ id: "m" }, { id: "other" }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await validateModelExists("https://x", "m", "k")).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe("https://x/models");
    expect(await validateModelExists("https://x", "missing", "k")).toBe(false);
  });

  it("returns false on non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    expect(await validateModelExists("https://x", "m", "k")).toBe(false);
  });
});
