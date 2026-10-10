import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as core from "@actions/core";
import {
  resolveEndpoint,
  buildEndpointForStyle,
  UnsupportedModelError,
  validateModelExists,
  authHeaderFor,
} from "../src/providers.js";

vi.mock("@actions/core", () => ({ warning: vi.fn() }));

const base = { llmBaseUrl: "", llmApiStyle: "auto", llmPath: "", llmApiKey: "k", prNumber: 1 } as const;

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

  // Spec §9.5: auto consults no map — it resolves the chat default, and the
  // probe (callWithProbe) discovers the working style from 400/404 errors.
  it("auto resolves openai-chat for every provider (the probe decides the style)", () => {
    for (const [provider, model] of [
      ["opencode-zen", "qwen3.8-max"],
      ["opencode-go", "qwen3.8-max"],
      ["opencode-zen", "gpt-6-luna"],
      ["opencode-zen", "claude-sonnet-5-5"],
      ["opencode-zen", "gemini-3.8-flash"],
    ] as const) {
      const r = resolveEndpoint({ ...base, llmProvider: provider, llmModel: model });
      expect(r.apiStyle).toBe("openai-chat");
      expect(r.path).toBe("/chat/completions");
    }
  });

  it("zen sends no session header, go does", () => {
    const z = resolveEndpoint({ ...base, llmProvider: "opencode-zen", llmModel: "deepseek-v4.1-flash" });
    expect(z.headers["User-Agent"]).toContain("pr-reviewer");
    expect(z.headers["x-opencode-session"]).toBeUndefined();
    const g = resolveEndpoint({ ...base, llmProvider: "opencode-go", llmModel: "glm-5.3-flash" });
    expect(g.headers["x-opencode-session"]).toBe("pr-1");
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

  // Explicit marker: resolveEndpoint warns iff the base came from the user AND was stripped.
  it("resolveEndpoint honors an explicit userBase=false even with a non-empty llm_base_url", () => {
    const r = resolveEndpoint({
      ...base,
      llmProvider: "custom",
      llmBaseUrl: "https://x/v1beta/openai",
      llmModel: "gemini-x",
      llmApiStyle: "google-models",
      userBase: false,
    });
    expect(r.baseUrl).toBe("https://x/v1beta");
    expect(core.warning).not.toHaveBeenCalled();
  });

  it("resolveEndpoint honors an explicit userBase=true (warns on the strip)", () => {
    const r = resolveEndpoint({
      ...base,
      llmProvider: "custom",
      llmBaseUrl: "https://x/v1beta/openai",
      llmModel: "gemini-x",
      llmApiStyle: "google-models",
      userBase: true,
    });
    expect(r.baseUrl).toBe("https://x/v1beta");
    expect(core.warning).toHaveBeenCalledTimes(1);
  });

  it("prNumber null ok, go without number omits session header", () => {
    expect(resolveEndpoint({ ...base, llmProvider: "openai", llmModel: "m", prNumber: null }).headers["x-opencode-session"]).toBeUndefined();
    expect(resolveEndpoint({ ...base, llmProvider: "opencode-go", llmModel: "glm-5.3-flash", prNumber: null }).headers["x-opencode-session"]).toBeUndefined();
    const g = resolveEndpoint({ ...base, llmProvider: "opencode-go", llmModel: "glm-5.3-flash" });
    expect(g.headers["x-opencode-session"]).toBe("pr-1");
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

  // Spec §9.5: the "explicit openai-chat on a non-chat pair" fail-fast is gone —
  // an explicit openai-chat is honored on every pair, chat body sent as-is.
  it("explicit openai-chat is honored on every pair (no map, no fail-fast)", () => {
    expect(
      resolveEndpoint({ ...base, llmProvider: "opencode-zen", llmModel: "gpt-6-luna", llmApiStyle: "openai-chat" }).path,
    ).toBe("/chat/completions");
    expect(
      resolveEndpoint({ ...base, llmProvider: "opencode-go", llmModel: "qwen3.8-max", llmApiStyle: "openai-chat" }).path,
    ).toBe("/chat/completions");
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

describe("buildEndpointForStyle", () => {
  // R3-warning fix: the probe's synthetic base must not read as user-supplied.
  it("a preset-derived base stripped for google-models does NOT warn (probe misfire)", () => {
    const r = buildEndpointForStyle(
      "google",
      "gemini-x",
      "https://generativelanguage.googleapis.com/v1beta/openai",
      "k",
      "google-models",
    );
    expect(r.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");
    expect(r.path).toBe("/models/gemini-x:generateContent");
    expect(core.warning).not.toHaveBeenCalled();
  });

  it("a user-supplied base stripped for google-models DOES warn (userBase: true)", () => {
    const r = buildEndpointForStyle("custom", "gemini-x", "https://x/v1beta/openai", "k", "google-models", null, true);
    expect(r.baseUrl).toBe("https://x/v1beta");
    expect(core.warning).toHaveBeenCalledTimes(1);
    const msg = vi.mocked(core.warning).mock.calls[0][0] as string;
    expect(msg).toContain("https://x/v1beta/openai");
    expect(msg).toContain("https://x/v1beta");
  });

  it("no strip and no warning for a base without the /openai suffix", () => {
    const r = buildEndpointForStyle("opencode-go", "m", "https://opencode.ai/zen/go/v1", "k", "openai-responses", 7);
    expect(r.baseUrl).toBe("https://opencode.ai/zen/go/v1");
    expect(r.path).toBe("/responses");
    expect(r.headers["x-opencode-session"]).toBe("pr-7");
    expect(core.warning).not.toHaveBeenCalled();
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
