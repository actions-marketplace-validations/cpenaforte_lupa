import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  callLlm,
  validateSampling,
  tokenFieldFor,
  parseContent,
  ensureOllama,
  OllamaMissingError,
  InvalidJsonError,
} from "../src/llm.js";
import type { ResolvedEndpoint } from "../src/providers.js";

// ---------- helpers ----------

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];

function stubFetch(h: (c: Call, n: number) => Promise<Response> | Response): void {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init: RequestInit = {}) => {
      const c = { url: String(url), init };
      calls.push(c);
      return h(c, calls.length);
    }),
  );
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const okChat = (content: string | null = '{"findings":[]}', extra: Record<string, unknown> = {}) => ({
  choices: [{ finish_reason: "stop", message: { content, ...extra } }],
});

function lastBody(): any {
  return JSON.parse(String(calls.at(-1)!.init.body));
}

function fetchCallCount(): number {
  return calls.length;
}

/** Endpoint per provider: base URL + chat path + bearer header with a dummy key. */
function fakeEp(p: string, key = "k"): ResolvedEndpoint {
  return {
    baseUrl: `https://${p}.test/v1`,
    path: "/chat/completions",
    headers: { Authorization: `Bearer ${key}`, "User-Agent": "pr-reviewer/1.0" },
  };
}
const fakeOpenAiEp = () => fakeEp("openai");
const fakeAnthropicEp = () => fakeEp("anthropic");
const fakeOllamaEp = () => fakeEp("ollama");

function msgs(): { system: string; user: string } {
  return { system: "s", user: '{"findings":[]}' };
}

function opts(provider = "openai") {
  return {
    model: "m",
    apiKey: "k",
    maxTokens: 50,
    timeoutSeconds: 5,
    provider,
  };
}

beforeEach(() => {
  calls = [];
  stubFetch(() => json(200, okChat()));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Fetch mock returning a refusal alongside valid content; true iff callLlm treated it as failure. */
async function refusalHonored(p: string): Promise<boolean> {
  stubFetch(() => json(200, okChat('{"findings":[]}', { refusal: "x" })));
  const r = await callLlm(fakeEp(p), msgs(), opts(p));
  return !r.ok;
}

/** Fetch mock that never answers until aborted; resolves with the LlmResult. */
function callLlmWithTimeout(timeoutSeconds: number) {
  stubFetch(
    (c) =>
      new Promise<Response>((_, rej) => {
        c.init.signal?.addEventListener("abort", () =>
          rej(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      }),
  );
  return callLlm(fakeOpenAiEp(), msgs(), { ...opts(), timeoutSeconds });
}

/** Fetch mock answering 500 for every attempt; never throws. */
function callLlmFailing(key: string) {
  stubFetch(() => json(500, { error: `upstream rejected key ${key}` }));
  return callLlm(fakeEp("openai", key), msgs(), { ...opts(), apiKey: key });
}

/** Fetch mock throwing a network error that echoes the key. */
function callLlmThrowing(key: string) {
  stubFetch(() => {
    throw new Error(`getaddrinfo failed (auth ${key})`);
  });
  return callLlm(fakeEp("openai", key), msgs(), { ...opts(), apiKey: key });
}

// ---------- tests ----------

describe("validateSampling", () => {
  it("rejects bad sampling per family, allows generic ranges", () => {
    expect(() => validateSampling({ model: "o1", temperature: 0.5, provider: "openai" })).toThrow(/reasoning/);
    expect(() => validateSampling({ model: "o3-mini", provider: "openai", n: 2 })).toThrow(/reasoning/);
    expect(() => validateSampling({ model: "claude-sonnet-5-5", temperature: 0, provider: "anthropic" })).toThrow(/400|reasoning/);
    expect(() => validateSampling({ model: "x", provider: "anthropic", n: 2 })).toThrow(/n/);
    expect(() => validateSampling({ model: "m", provider: "custom", apiStyle: "anthropic-messages", temperature: 0.5, topP: 0.9 })).toThrow(/both|together/);
    expect(() => validateSampling({ model: "generic-claude", provider: "anthropic", temperature: 0.5 })).not.toThrow();
    expect(() => validateSampling({ model: "generic-claude", provider: "anthropic", topP: 0.9 })).not.toThrow();
    expect(() => validateSampling({ model: "gpt-6-luna", provider: "openai", topP: 0.9 })).toThrow(/reasoning/);
    expect(() => validateSampling({ model: "gpt-6-luna", provider: "openai", n: 2 })).toThrow(/reasoning/);
    expect(() => validateSampling({ model: "m", provider: "openai", n: 2 })).not.toThrow();
    expect(() => validateSampling({ model: "x", provider: "anthropic" })).not.toThrow();
  });

  it("matches strict family case-insensitively (O1, claude-4.8, claude-4.10, haiku-5-5)", () => {
    expect(() => validateSampling({ model: "O1", provider: "openai", temperature: 0.5 })).toThrow(/reasoning/);
    expect(() => validateSampling({ model: "claude-4.8", provider: "custom", temperature: 0.5 })).toThrow(/reasoning/);
    expect(() => validateSampling({ model: "claude-4.10", provider: "custom", topP: 0.5 })).toThrow(/reasoning/);
    expect(() => validateSampling({ model: "claude-haiku-5-5", provider: "anthropic", topP: 0.5 })).toThrow(/400|reasoning/);
  });

  it("generic anthropic-compat range checks: out-of-range throws, in-range passes", () => {
    expect(() => validateSampling({ model: "x", provider: "anthropic", temperature: 1.5 })).toThrow();
    expect(() => validateSampling({ model: "x", provider: "anthropic", topP: -0.1 })).toThrow();
    expect(() => validateSampling({ model: "x", provider: "anthropic", temperature: 1, topP: undefined, n: 1 })).not.toThrow();
  });
});

describe("tokenFieldFor", () => {
  it("maps reasoning to max_completion_tokens, never claude", () => {
    expect(tokenFieldFor("gpt-6-luna")).toBe("max_completion_tokens");
    expect(tokenFieldFor("o1")).toBe("max_completion_tokens");
    expect(tokenFieldFor("o3-mini")).toBe("max_completion_tokens");
    expect(tokenFieldFor("claude-sonnet-5-5")).toBe("max_tokens");
    expect(tokenFieldFor("deepseek-v4.1-flash")).toBe("max_tokens");
  });
});

describe("callLlm request shape", () => {
  it("explicit sampling IS sent for openai non-reasoning, still omitted for anthropic", async () => {
    await callLlm(fakeOpenAiEp(), msgs(), { ...opts(), model: "gpt-4o-mini", temperature: 0.3 });
    expect(lastBody().temperature).toBe(0.3);
    await callLlm(fakeAnthropicEp(), msgs(), { ...opts("anthropic"), temperature: 0.3 });
    expect(lastBody().temperature).toBeUndefined();
  });

  it("omits temperature/top_p/n by default", async () => {
    await callLlm(fakeOpenAiEp(), msgs(), opts());
    expect(lastBody().temperature).toBeUndefined();
    expect(lastBody().top_p).toBeUndefined();
    expect(lastBody().n).toBeUndefined();
  });

  it("zen-chat gets strict full shape like openai", async () => {
    await callLlm(fakeEp("opencode-zen"), msgs(), { ...opts("opencode-zen"), model: "deepseek-v4.1-flash" });
    expect(lastBody().response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: "pr_review", strict: true },
    });
  });

  it("response_format per provider: strict openai, json_object groq/mistral, omitted anthropic", async () => {
    await callLlm(fakeEp("groq"), msgs(), opts("groq"));
    expect(lastBody().response_format.type).toBe("json_object");
    expect(lastBody().response_format.json_schema?.strict).not.toBe(true);
  });

  it("omits response_format for anthropic, non-strict for ollama, full shape for openai", async () => {
    await callLlm(fakeAnthropicEp(), msgs(), opts("anthropic"));
    expect(lastBody().response_format).toBeUndefined();
    await callLlm(fakeOllamaEp(), msgs(), opts("ollama"));
    expect(lastBody().response_format).toBeDefined();
    expect(lastBody().response_format.type).toBe("json_object");
    expect(lastBody().response_format.json_schema?.strict).not.toBe(true);
    await callLlm(fakeOpenAiEp(), msgs(), opts());
    expect(lastBody().response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: "pr_review", strict: true },
    });
  });

  it("uses max_completion_tokens for reasoning and max_tokens otherwise", async () => {
    await callLlm(fakeOpenAiEp(), msgs(), { ...opts(), model: "o1" });
    expect(lastBody().max_completion_tokens).toBe(50);
    expect(lastBody().max_tokens).toBeUndefined();
    await callLlm(fakeAnthropicEp(), msgs(), { ...opts("anthropic"), model: "claude-sonnet-5-5" });
    expect(lastBody().max_tokens).toBe(50);
    expect(lastBody().max_completion_tokens).toBeUndefined();
  });

  it("sends Authorization from the endpoint headers and posts to base+path", async () => {
    await callLlm(fakeOpenAiEp(), msgs(), opts());
    expect(calls.at(-1)!.url).toBe("https://openai.test/v1/chat/completions");
    expect((calls.at(-1)!.init.headers as Record<string, string>).Authorization).toBe("Bearer k");
    expect(calls.at(-1)!.init.method).toBe("POST");
  });
});

describe("callLlm response handling", () => {
  it("ignores refusal on anthropic, honors elsewhere", async () => {
    expect(await refusalHonored("anthropic")).toBe(false);
    expect(await refusalHonored("openai")).toBe(true);
    expect(await refusalHonored("ollama")).toBe(true);
  });

  it("strips markdown fences (json and bare) before parse", async () => {
    expect(parseContent("```json\n{\"findings\":[]}\n```")).toEqual({ findings: [] });
    expect(parseContent("```\n{\"findings\":[]}\n```")).toEqual({ findings: [] });
    expect(parseContent('  {"findings":[]}  ')).toEqual({ findings: [] });
  });

  it("parseContent throws InvalidJsonError on non-JSON", () => {
    expect(() => parseContent("not json")).toThrow(InvalidJsonError);
  });

  it("accepts fence-wrapped JSON content end to end", async () => {
    stubFetch(() => json(200, okChat('```json\n{"findings":[]}\n```')));
    expect(await callLlm(fakeOpenAiEp(), msgs(), opts())).toEqual({ ok: true, findings: [] });
  });

  it("maps findings to exactly {severity,file,line?,rule,message,suggestion?}, null to undefined", async () => {
    const content = JSON.stringify({
      findings: [
        { severity: "high", file: "a.ts", line: null, rule: "r1", message: "m1", suggestion: null },
        { severity: "warning", file: "b.ts", line: 7, rule: "r2", message: "m2", suggestion: "fix" },
      ],
    });
    stubFetch(() => json(200, okChat(content)));
    const r = await callLlm(fakeOpenAiEp(), msgs(), opts());
    expect(r).toEqual({
      ok: true,
      findings: [
        { severity: "high", file: "a.ts", rule: "r1", message: "m1" },
        { severity: "warning", file: "b.ts", line: 7, rule: "r2", message: "m2", suggestion: "fix" },
      ],
    });
    expect(r.ok && "line" in r.findings[0]).toBe(false);
    expect(r.ok && "suggestion" in r.findings[0]).toBe(false);
  });

  it("schema-invalid content is invalid-json", async () => {
    stubFetch(() => json(200, okChat(JSON.stringify({ findings: [{ severity: "critical", file: "a", line: null, rule: "r", message: "m", suggestion: null }] }))));
    expect(await callLlm(fakeOpenAiEp(), msgs(), opts())).toMatchObject({ ok: false, reason: "invalid-json" });
    stubFetch(() => json(200, okChat('{"notFindings":[]}')));
    expect(await callLlm(fakeOpenAiEp(), msgs(), opts())).toMatchObject({ ok: false, reason: "invalid-json" });
  });

  it("finish_reason length degrades to invalid-json; content_filter is content-filter", async () => {
    stubFetch(() => json(200, { choices: [{ finish_reason: "length", message: { content: '{"findings":[]}' } }] }));
    expect(await callLlm(fakeOpenAiEp(), msgs(), opts())).toMatchObject({ ok: false, reason: "invalid-json" });
    stubFetch(() => json(200, { choices: [{ finish_reason: "content_filter", message: { content: null } }] }));
    expect(await callLlm(fakeOpenAiEp(), msgs(), opts())).toMatchObject({ ok: false, reason: "content-filter" });
  });

  it("returns no-key without calling fetch", async () => {
    const r = await callLlm(fakeOpenAiEp(), msgs(), { ...opts(), apiKey: "" });
    expect(r).toMatchObject({ ok: false, reason: "no-key" });
    expect(fetchCallCount()).toBe(0);
  });

  it("sampling validation failure is unsupported and makes no request", async () => {
    const r = await callLlm(fakeOpenAiEp(), msgs(), { ...opts(), model: "o1", temperature: 0.5 });
    expect(r).toMatchObject({ ok: false, reason: "unsupported" });
    expect(fetchCallCount()).toBe(0);
  });
});

describe("retry and timeout", () => {
  it("timeout degrades without retry", async () => {
    const r = await callLlmWithTimeout(1);
    expect(r).toMatchObject({ ok: false, reason: "timeout" });
    expect(fetchCallCount()).toBe(1);
  }, 15000);

  it("retries 5xx once then succeeds", async () => {
    stubFetch((_c, n) => (n === 1 ? json(503, { error: "busy" }) : json(200, okChat())));
    expect(await callLlm(fakeOpenAiEp(), msgs(), opts())).toEqual({ ok: true, findings: [] });
    expect(fetchCallCount()).toBe(2);
  }, 15000);

  it("retries 429 honoring Retry-After", async () => {
    stubFetch((_c, n) => (n === 1 ? json(429, {}, { "retry-after": "0" }) : json(200, okChat())));
    expect(await callLlm(fakeOpenAiEp(), msgs(), opts())).toEqual({ ok: true, findings: [] });
    expect(fetchCallCount()).toBe(2);
  });

  it("gives up after one retry on persistent 5xx", async () => {
    stubFetch(() => json(500, {}));
    expect(await callLlm(fakeOpenAiEp(), msgs(), opts())).toMatchObject({ ok: false, reason: "http-error" });
    expect(fetchCallCount()).toBe(2);
  }, 15000);

  it("does not retry 4xx", async () => {
    stubFetch(() => json(400, { error: "bad" }));
    expect(await callLlm(fakeOpenAiEp(), msgs(), opts())).toMatchObject({ ok: false, reason: "http-error" });
    expect(fetchCallCount()).toBe(1);
  });

  it("network throw is http-error without retry", async () => {
    stubFetch(() => {
      throw new Error("ECONNRESET");
    });
    expect(await callLlm(fakeOpenAiEp(), msgs(), opts())).toMatchObject({ ok: false, reason: "http-error" });
    expect(fetchCallCount()).toBe(1);
  });
});

describe("secret redaction", () => {
  it("never leaks api key in result or throw", async () => {
    const r = await callLlmFailing("sk-secret-xyz");
    expect(JSON.stringify(r)).not.toContain("sk-secret-xyz");
    const err = await callLlmThrowing("sk-secret-xyz").catch((e) => String(e));
    expect(String(err)).not.toContain("sk-secret-xyz");
  }, 15000);
});

describe("ensureOllama", () => {
  it("healthchecks root then POSTs /api/pull with the model (v1 suffix stripped)", async () => {
    stubFetch((c) =>
      c.url.endsWith("/api/pull")
        ? json(200, { status: "success" })
        : new Response("Ollama is running", { status: 200 }),
    );
    await ensureOllama("http://localhost:11434/v1", "qwen3:8b");
    expect(calls[0]!.url).toBe("http://localhost:11434/");
    expect(calls[1]!.url).toBe("http://localhost:11434/api/pull");
    expect(calls[1]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[1]!.init.body))).toMatchObject({ model: "qwen3:8b", stream: false });
  });

  it("pull 404 throws OllamaMissingError", async () => {
    stubFetch((c) => (c.url.endsWith("/api/pull") ? json(404, { error: "not found" }) : new Response("ok", { status: 200 })));
    await expect(ensureOllama("http://localhost:11434/v1", "nope")).rejects.toBeInstanceOf(OllamaMissingError);
  });

  it("pull body error throws", async () => {
    stubFetch((c) => (c.url.endsWith("/api/pull") ? json(200, { error: "disk full" }) : new Response("ok", { status: 200 })));
    await expect(ensureOllama("http://localhost:11434/v1", "m")).rejects.toThrow(/disk full/);
  });

  it("unreachable server throws before pulling", async () => {
    stubFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    await expect(ensureOllama("http://localhost:11434/v1", "m")).rejects.toThrow();
    expect(fetchCallCount()).toBe(1);
  });
});
