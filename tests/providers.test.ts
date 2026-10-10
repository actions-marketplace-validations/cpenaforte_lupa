import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as core from "@actions/core";
import {
  resolveEndpoint,
  UnsupportedModelError,
  validateModelExists,
  authHeaderFor,
  NON_CHAT,
} from "../src/providers.js";

vi.mock("@actions/core", () => ({ warning: vi.fn() }));

const base = { llmBaseUrl: "", llmApiStyle: "auto", llmPath: "", llmApiKey: "k", prNumber: 1 } as const;

const ZEN_CHAT = ["deepseek-v4.1-flash", "deepseek-v4-pro", "deepseek-v4-flash", "glm-5.3-flash", "glm-5.3", "glm-5.2", "kimi-k3", "kimi-k2.7-code", "kimi-k2.6", "minimax-m3", "minimax-m2.7", "mistral-large-4", "qwen3.8-max", "big-pickle", "space-bunny-free", "mimo-v2.6-flash-free"];
const ZEN_NON_CHAT = ["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra", "grok-4.7", "grok-4.6", "claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "qwen3.7-max", "qwen3.7-plus", "gemini-3.8-flash", "gemini-3.5-flash-lite", "muse-spark-1.3-contributor-free"];
const GO_CHAT = ["glm-5.3-flash", "glm-5.3", "glm-5.2", "kimi-k3", "kimi-k2.7-code", "kimi-k2.6", "deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4.1-flash", "deepseek-v4-flash-vision-exp", "mimo-v2.6-flash", "mimo-v2.5", "mimo-v2.6-pro", "hy4-preview", "hy3", "longcat-2.0", "space-bunny"];
const GO_NON_CHAT = ["grok-4.7", "grok-4.6", "gpt-6-luna", "gpt-5.6-luna", "gpt-6.1-sol", "gpt-6-astra", "muse-spark-1.3-contributor", "claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "minimax-m3", "minimax-m2.7", "qwen3.8-max", "qwen3.8-flash", "qwen3.7-max", "qwen3.7-plus", "gemini-3.8-flash", "gemini-3.5-flash-lite"];

beforeEach(() => {
  vi.mocked(core.warning).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("resolveEndpoint", () => {
  it("base and path are separate for zen", () => {
    const r = resolveEndpoint({ ...base, llmProvider: "opencode-zen", llmModel: "glm-5.3-flash" });
    expect(r.baseUrl).toBe("https://opencode.ai/zen/v1");
    expect(r.path).toBe("/chat/completions");
  });

  it("zen qwen3.8-max resolves chat, go qwen3.8-max resolves anthropic-messages", () => {
    expect(resolveEndpoint({ ...base, llmProvider: "opencode-zen", llmModel: "qwen3.8-max" }).path).toBe("/chat/completions");
    const go = resolveEndpoint({ ...base, llmProvider: "opencode-go", llmModel: "qwen3.8-max" });
    expect(go.apiStyle).toBe("anthropic-messages");
    expect(go.path).toBe("/messages");
  });

  it("zen sends no session header, go does", () => {
    const z = resolveEndpoint({ ...base, llmProvider: "opencode-zen", llmModel: "deepseek-v4.1-flash" });
    expect(z.headers["User-Agent"]).toContain("pr-reviewer");
    expect(z.headers["x-opencode-session"]).toBeUndefined();
    const g = resolveEndpoint({ ...base, llmProvider: "opencode-go", llmModel: "glm-5.3-flash" });
    expect(g.headers["x-opencode-session"]).toBe("pr-1");
  });

  it("matrix: documented chat models resolve chat, non-chat models resolve their adapter", () => {
    for (const m of ZEN_CHAT) {
      expect(resolveEndpoint({ ...base, llmProvider: "opencode-zen", llmModel: m }).path).toBe("/chat/completions");
    }
    expect(resolveEndpoint({ ...base, llmProvider: "opencode-zen", llmModel: "gpt-6-luna" }).apiStyle).toBe("openai-responses");
    expect(resolveEndpoint({ ...base, llmProvider: "opencode-zen", llmModel: "claude-sonnet-5-5" }).apiStyle).toBe("anthropic-messages");
  });

  it("zen non-chat models resolve to their v2 adapter (no fail-fast)", () => {
    for (const m of ZEN_NON_CHAT) {
      const r = resolveEndpoint({ ...base, llmProvider: "opencode-zen", llmModel: m });
      expect(r.apiStyle).toBe(NON_CHAT.get(`opencode-zen:${m}`));
      expect(r.path).not.toBe("/chat/completions");
    }
  });

  it("go chat models resolve chat, go non-chat models resolve their adapter", () => {
    for (const m of GO_CHAT) {
      expect(resolveEndpoint({ ...base, llmProvider: "opencode-go", llmModel: m }).path).toBe("/chat/completions");
    }
    for (const m of GO_NON_CHAT) {
      const r = resolveEndpoint({ ...base, llmProvider: "opencode-go", llmModel: m });
      expect(r.apiStyle).toBe(NON_CHAT.get(`opencode-go:${m}`));
      expect(r.path).not.toBe("/chat/completions");
    }
  });

  it("llm_path to non-chat without v2 style throws path-only error", () => {
    expect(() => resolveEndpoint({ ...base, llmProvider: "custom", llmBaseUrl: "https://x", llmModel: "m", llmPath: "/messages" })).toThrow(/path-only/);
  });

  it("explicit v2 api_style is functional and picks the adapter path", () => {
    expect(resolveEndpoint({ ...base, llmProvider: "openai", llmModel: "m", llmApiStyle: "anthropic-messages" }).path).toBe("/messages");
  });

  // R3: the /openai-suffix strip is surfaced when it rewrites a USER-SUPPLIED base URL.
  it("warns when a user-supplied custom base ending in /openai is rewritten for google-models", () => {
    const r = resolveEndpoint({
      ...base,
      llmProvider: "custom",
      llmBaseUrl: "https://x/v1beta/openai",
      llmModel: "gemini-x",
      llmApiStyle: "google-models",
    });
    expect(r.baseUrl).toBe("https://x/v1beta");
    expect(core.warning).toHaveBeenCalledTimes(1);
    const msg = vi.mocked(core.warning).mock.calls[0][0] as string;
    expect(msg).toContain("https://x/v1beta/openai");
    expect(msg).toContain("https://x/v1beta");
  });

  it("preset google base rewrite (not user-supplied) does not warn", () => {
    resolveEndpoint({ ...base, llmProvider: "google", llmModel: "gemini-x", llmApiStyle: "google-models" });
    expect(core.warning).not.toHaveBeenCalled();
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
    // Spec ids: Zen Muse-Spark free variant (§9.1).
    expect(NON_CHAT.get("opencode-zen:muse-spark-1.3-contributor-free")).toBe("openai-responses");
    expect(NON_CHAT.has("opencode-zen:qwen3.8-max")).toBe(false);
  });

  // Spec §9.2: the Claude Fable family is anthropic-messages on Zen/Go (prefix rule, not an exact id).
  it("claude-fable-* resolves anthropic-messages on zen and go, chat elsewhere", () => {
    for (const provider of ["opencode-zen", "opencode-go"] as const) {
      const r = resolveEndpoint({ ...base, llmProvider: provider, llmModel: "claude-fable-5-5" });
      expect(r.apiStyle).toBe("anthropic-messages");
      expect(r.path).toBe("/messages");
      expect(() =>
        resolveEndpoint({ ...base, llmProvider: provider, llmModel: "claude-fable-5-5", llmApiStyle: "openai-chat" }),
      ).toThrow(UnsupportedModelError);
    }
    expect(resolveEndpoint({ ...base, llmProvider: "openai", llmModel: "claude-fable-5-5" }).apiStyle).toBe("openai-chat");
  });

  // F10: no chat-capable pair may be in NON_CHAT.
  it("NON_CHAT has no key for any chat-supported zen or go model", () => {
    for (const m of ZEN_CHAT) expect(NON_CHAT.has(`opencode-zen:${m}`)).toBe(false);
    for (const m of GO_CHAT) expect(NON_CHAT.has(`opencode-go:${m}`)).toBe(false);
  });

  // F9: preset table, all nine presets.
  it.each([
    ["openai", "https://api.openai.com/v1"],
    ["anthropic", "https://api.anthropic.com/v1"],
    ["google", "https://generativelanguage.googleapis.com/v1beta/openai"],
    ["groq", "https://api.groq.com/openai/v1"],
    ["mistral", "https://api.mistral.ai/v1"],
    ["openrouter", "https://openrouter.ai/api/v1"],
    ["ollama", "http://localhost:11434/v1"],
    ["opencode-zen", "https://opencode.ai/zen/v1"],
    ["opencode-go", "https://opencode.ai/zen/go/v1"],
  ] as const)("preset %s baseUrl is exact and path-free", (provider, expected) => {
    const r = resolveEndpoint({ ...base, llmProvider: provider, llmModel: "m" });
    expect(r.baseUrl).toBe(expected);
    expect(r.path).toBe("/chat/completions");
  });

  it("custom requires llm_base_url", () => {
    expect(() => resolveEndpoint({ ...base, llmProvider: "custom", llmModel: "m" })).toThrow(/requires llm_base_url/);
    expect(resolveEndpoint({ ...base, llmProvider: "custom", llmBaseUrl: "https://c.example/v1/", llmModel: "m" }).baseUrl).toBe("https://c.example/v1");
  });

  // F1 / F12: explicit openai-chat on a non-chat pair fails fast.
  it("explicit openai-chat on a NON_CHAT pair throws UnsupportedModelError", () => {
    expect(() => resolveEndpoint({ ...base, llmProvider: "opencode-zen", llmModel: "gpt-6-luna", llmApiStyle: "openai-chat" })).toThrow(UnsupportedModelError);
    expect(() => resolveEndpoint({ ...base, llmProvider: "opencode-go", llmModel: "qwen3.8-max", llmApiStyle: "openai-chat" })).toThrow(UnsupportedModelError);
  });

  it("explicit openai-chat on a chat pair resolves", () => {
    expect(resolveEndpoint({ ...base, llmProvider: "opencode-zen", llmModel: "qwen3.8-max", llmApiStyle: "openai-chat" }).path).toBe("/chat/completions");
  });

  // F12 (v2): explicit v2 styles resolve to their adapter path.
  it.each([
    ["openai-responses", "/responses"],
    ["google-models", "/models/m:generateContent"],
  ] as const)("explicit %s resolves with path %s", (style, path) => {
    expect(resolveEndpoint({ ...base, llmProvider: "openai", llmModel: "m", llmApiStyle: style }).path).toBe(path);
  });

  // F12: custom-path needs llm_path; plain Error (R2).
  it("explicit custom-path with empty llm_path throws plain Error", () => {
    let caught: unknown;
    try {
      resolveEndpoint({ ...base, llmProvider: "custom", llmBaseUrl: "https://x", llmModel: "m", llmApiStyle: "custom-path" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(UnsupportedModelError);
    expect((caught as Error).message).toMatch(/requires llm_path/);
  });

  // F5: path-segment matching.
  it("path containing /models mid-path does NOT throw path-only", () => {
    const r = resolveEndpoint({ ...base, llmProvider: "openai", llmModel: "m", llmPath: "/openai/models/chat/completions" });
    expect(r.path).toBe("/openai/models/chat/completions");
  });

  it("bare messages (no leading slash) throws path-only after normalization", () => {
    expect(() => resolveEndpoint({ ...base, llmProvider: "custom", llmBaseUrl: "https://x", llmModel: "m", llmPath: "messages" })).toThrow(/path-only/);
  });

  it("path without leading slash joins with one slash", () => {
    const r = resolveEndpoint({ ...base, llmProvider: "custom", llmBaseUrl: "https://x", llmModel: "m", llmPath: "chat/completions" });
    expect(r.path).toBe("/chat/completions");
    expect(r.baseUrl + r.path).toBe("https://x/chat/completions");
  });

  it("returned path strips #fragment and ?query", () => {
    expect(resolveEndpoint({ ...base, llmProvider: "custom", llmBaseUrl: "https://x", llmModel: "m", llmPath: "/chat/completions#x" }).path).toBe("/chat/completions");
    expect(resolveEndpoint({ ...base, llmProvider: "custom", llmBaseUrl: "https://x", llmModel: "m", llmPath: "/chat/completions?a=1" }).path).toBe("/chat/completions");
  });

  it("bare query-bearing messages?x=1 throws path-only", () => {
    expect(() => resolveEndpoint({ ...base, llmProvider: "custom", llmBaseUrl: "https://x", llmModel: "m", llmPath: "messages?x=1" })).toThrow(/path-only/);
  });

  it("path-only message quotes raw (query stripped) and normalized path, never the query", () => {
    let msg = "";
    try {
      resolveEndpoint({ ...base, llmProvider: "custom", llmBaseUrl: "https://x", llmModel: "m", llmPath: "messages?key=SECRET" });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('llm_path "messages" normalizes to "/messages"');
    expect(msg).not.toContain("SECRET");
    expect(msg).not.toContain("key=");
  });

  it("warns once naming the stripped query string, without its value", () => {
    resolveEndpoint({ ...base, llmProvider: "custom", llmBaseUrl: "https://x", llmModel: "m", llmPath: "/chat/completions?a=SECRET" });
    expect(core.warning).toHaveBeenCalledTimes(1);
    const msg = vi.mocked(core.warning).mock.calls[0][0] as string;
    expect(msg).toContain("query string");
    expect(msg).not.toContain("SECRET");
  });

  it("warns naming the stripped fragment", () => {
    resolveEndpoint({ ...base, llmProvider: "custom", llmBaseUrl: "https://x", llmModel: "m", llmPath: "/chat/completions#frag" });
    expect(core.warning).toHaveBeenCalledTimes(1);
    expect(vi.mocked(core.warning).mock.calls[0][0]).toContain("fragment");
  });

  it("no warning for a clean path", () => {
    resolveEndpoint({ ...base, llmProvider: "custom", llmBaseUrl: "https://x", llmModel: "m", llmPath: "/chat/completions" });
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('"/messages#x" throws path-only (fragment stripped)', () => {
    expect(() => resolveEndpoint({ ...base, llmProvider: "custom", llmBaseUrl: "https://x", llmModel: "m", llmPath: "/messages#x" })).toThrow(/path-only/);
  });

  it("joins baseUrl and path with exactly one slash", () => {
    const r = resolveEndpoint({ ...base, llmProvider: "custom", llmBaseUrl: "https://x/v1/", llmModel: "m", llmPath: "/chat/completions" });
    expect(r.baseUrl + r.path).toBe("https://x/v1/chat/completions");
  });

  it("/v1/chat/completions resolves", () => {
    expect(resolveEndpoint({ ...base, llmProvider: "custom", llmBaseUrl: "https://x", llmModel: "m", llmPath: "/v1/chat/completions" }).path).toBe("/v1/chat/completions");
  });

  it("/openai/models/chat/completions resolves (last segment is completions)", () => {
    expect(resolveEndpoint({ ...base, llmProvider: "custom", llmBaseUrl: "https://x", llmModel: "m", llmPath: "/openai/models/chat/completions" }).path).toBe("/openai/models/chat/completions");
  });

  it("/v1/messages throws path-only (last segment)", () => {
    expect(() => resolveEndpoint({ ...base, llmProvider: "custom", llmBaseUrl: "https://x", llmModel: "m", llmPath: "/v1/messages" })).toThrow(/path-only/);
  });

  it.each(["/messages", "/responses", "/models", "/v1/responses", "/models?x=1", "/v1/messages/", "/messages/?x=1"])("path %s throws path-only", (p) => {
    expect(() => resolveEndpoint({ ...base, llmProvider: "custom", llmBaseUrl: "https://x", llmModel: "m", llmPath: p })).toThrow(/path-only/);
  });

  it("/messages/x resolves (last segment is x)", () => {
    expect(resolveEndpoint({ ...base, llmProvider: "custom", llmBaseUrl: "https://x", llmModel: "m", llmPath: "/messages/x" }).path).toBe("/messages/x");
  });
});

describe("validateModelExists", () => {
  it("checks id presence only and sends Bearer auth", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ data: [{ id: "m" }, { id: "other" }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await validateModelExists("https://x", "m", "k")).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe("https://x/models");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k");
    expect(await validateModelExists("https://x", "missing", "k")).toBe(false);
  });

  // R1: Google-native endpoints authenticate with x-goog-api-key, never Authorization.
  it("google-native sends x-goog-api-key and NOT Authorization", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ data: [{ id: "m" }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await validateModelExists("https://x", "m", "SECRETKEY", { header: "x-goog-api-key" })).toBe(true);
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("SECRETKEY");
    expect(headers.Authorization).toBeUndefined();
    expect(fetchMock.mock.calls[0][0]).not.toContain("SECRETKEY");
  });

  // R1: the auth header is derived from provider + resolved style at the call site.
  it("authHeaderFor: google + google-models is x-goog-api-key, everything else is Authorization", () => {
    expect(authHeaderFor("google", "google-models").header).toBe("x-goog-api-key");
    expect(authHeaderFor("google", "openai-chat").header).toBe("Authorization");
    expect(authHeaderFor("opencode-zen", "google-models").header).toBe("Authorization");
    expect(authHeaderFor("opencode-go", "google-models").header).toBe("Authorization");
    expect(authHeaderFor("custom", "anthropic-messages").header).toBe("Authorization");
  });

  // Micro fix 2: a custom provider on a native Google base must pair with callGoogle's POST auth.
  it("authHeaderFor: custom + google-models is x-goog-api-key (pairs with callGoogle)", () => {
    expect(authHeaderFor("custom", "google-models").header).toBe("x-goog-api-key");
  });

  // R4 / F2
  it("404 returns false", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    expect(await validateModelExists("https://x", "m", "k")).toBe(false);
  });

  it("500 throws naming the status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    await expect(validateModelExists("https://x", "m", "k")).rejects.toThrow(/500/);
  });

  it("500 with null body still throws naming the status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 500 })));
    await expect(validateModelExists("https://x", "m", "k")).rejects.toThrow(/500/);
  });

  it("401 throws naming the status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 401 })));
    await expect(validateModelExists("https://x", "m", "k")).rejects.toThrow(/401/);
  });

  it("invalid JSON on 200 throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 200 })));
    await expect(validateModelExists("https://x", "m", "k")).rejects.toThrow(/invalid JSON/);
  });

  // F4: timeout via AbortController. Fake timers keep this fast.
  it("aborts a slow request and rejects", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      ),
    );
    const pending = validateModelExists("https://x", "m", "k");
    const assertion = expect(pending).rejects.toThrow(/aborted/);
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
  });
});
