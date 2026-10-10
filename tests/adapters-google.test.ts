import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { callGoogle } from "../src/adapters/google.js";
import { PR_REVIEW_SCHEMA } from "../src/prompt.js";
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

/** Minimal generateContent envelope carrying one text part (`extra` lands on candidates[0]). */
const okGoogle = (text: string, extra: Record<string, unknown> = {}) => ({
  candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP", ...extra }],
});

function lastBody(): Record<string, unknown> {
  return JSON.parse(String(calls.at(-1)!.init.body)) as Record<string, unknown>;
}

/** Endpoint mirroring resolveEndpoint for the native Google path. */
function fakeGoogleEp(key = "k"): ResolvedEndpoint {
  return {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    path: "/models/gemini-2.5-flash:generateContent",
    headers: { "User-Agent": "pr-reviewer/1.0", "x-opencode-session": "pr-123" },
  };
}

function msgs(): { system: string; user: string } {
  return { system: "s", user: '{"findings":[]}' };
}

function opts() {
  return { apiKey: "k", maxTokens: 50, timeoutSeconds: 5 };
}

const MODEL = "gemini-2.5-flash";

beforeEach(() => {
  calls = [];
  stubFetch(() => json(200, okGoogle('{"findings":[]}')));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------- tests ----------

describe("callGoogle", () => {
  it("posts exact {contents, systemInstruction, generationConfig} body to /models/<id>:generateContent", async () => {
    const r = await callGoogle(fakeGoogleEp(), MODEL, msgs(), opts());
    expect(r).toEqual({ ok: true, findings: [] });
    // The endpoint path embeds the model id; the adapter posts to it as-is.
    expect(calls.at(-1)!.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    );
    expect(lastBody()).toEqual({
      contents: [{ role: "user", parts: [{ text: '{"findings":[]}' }] }],
      systemInstruction: { parts: [{ text: "s" }] },
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: PR_REVIEW_SCHEMA.schema,
        maxOutputTokens: 50,
      },
    });
  });

  it("uses the endpoint path as-is (Zen /models/<id> catalog path keeps Google body semantics)", async () => {
    const zenEp: ResolvedEndpoint = {
      baseUrl: "https://opencode.ai/zen/v1",
      path: "/models/gemini-2.5-flash",
      headers: { Authorization: "Bearer k", "User-Agent": "pr-reviewer/1.0" },
    };
    expect(await callGoogle(zenEp, MODEL, msgs(), opts())).toEqual({ ok: true, findings: [] });
    expect(calls.at(-1)!.url).toBe("https://opencode.ai/zen/v1/models/gemini-2.5-flash");
    expect(lastBody().contents).toEqual([{ role: "user", parts: [{ text: '{"findings":[]}' }] }]);
  });

  it("authenticates via x-goog-api-key header, never ?key= on the URL", async () => {
    const key = "SECRETKEY123";
    // Carries both Authorization casings: neither is part of this protocol.
    const ep: ResolvedEndpoint = {
      ...fakeGoogleEp(key),
      headers: {
        ...fakeGoogleEp(key).headers,
        Authorization: "Bearer stale",
        authorization: "Bearer stale",
      },
    };
    await callGoogle(ep, MODEL, msgs(), { ...opts(), apiKey: key });
    const headers = calls.at(-1)!.init.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe(key);
    expect(headers["User-Agent"]).toBe("pr-reviewer/1.0");
    expect(headers["x-opencode-session"]).toBe("pr-123");
    expect(headers.Authorization).toBeUndefined();
    expect(headers["authorization"]).toBeUndefined();
    // The key never rides the URL, so it can never be logged from a request line.
    expect(calls.at(-1)!.url).not.toContain(key);
    expect(calls.at(-1)!.url).not.toContain("?key=");
  });

  it("omits generationConfig sampling by default; explicit temperature/topP ride along", async () => {
    await callGoogle(fakeGoogleEp(), MODEL, msgs(), opts());
    const gc = lastBody().generationConfig as Record<string, unknown>;
    expect(gc).not.toHaveProperty("temperature");
    expect(gc).not.toHaveProperty("top_p");
    expect(gc).not.toHaveProperty("topP");

    await callGoogle(fakeGoogleEp(), MODEL, msgs(), { ...opts(), temperature: 0.2, topP: 0.9 });
    const gc2 = lastBody().generationConfig as Record<string, unknown>;
    expect(gc2.temperature).toBe(0.2);
    expect(gc2.topP).toBe(0.9);
  });

  it("falls back without responseSchema/responseMimeType on 400 and parses manually", async () => {
    stubFetch((_c, n) =>
      n === 1 ? json(400, { error: "responseSchema not supported" }) : json(200, okGoogle('{"findings":[]}')),
    );
    const r = await callGoogle(fakeGoogleEp(), MODEL, msgs(), opts());
    expect(r).toEqual({ ok: true, findings: [] });
    expect(calls.length).toBe(2);
    const first = JSON.parse(String(calls[0]!.init.body)) as { generationConfig?: Record<string, unknown> };
    expect(first.generationConfig?.responseSchema).toBeDefined();
    const second = JSON.parse(String(calls[1]!.init.body)) as { generationConfig?: Record<string, unknown> };
    expect(second.generationConfig).toBeDefined();
    expect(second.generationConfig).not.toHaveProperty("responseSchema");
    expect(second.generationConfig).not.toHaveProperty("responseMimeType");
    expect(second.generationConfig?.maxOutputTokens).toBe(50);
  });

  it("joins candidates[0].content.parts[].text and parses findings", async () => {
    stubFetch(() =>
      json(200, {
        candidates: [
          {
            content: { parts: [{ text: '{"findings":[' }, { text: "]}" }] },
            finishReason: "STOP",
          },
        ],
      }),
    );
    expect(await callGoogle(fakeGoogleEp(), MODEL, msgs(), opts())).toEqual({ ok: true, findings: [] });
  });

  it("finishReason STOP→ok; MAX_TOKENS→degrade; SAFETY/other→skip without retry", async () => {
    stubFetch(() => json(200, okGoogle('{"findings":[]}', { finishReason: "MAX_TOKENS" })));
    expect(await callGoogle(fakeGoogleEp(), MODEL, msgs(), opts())).toMatchObject({
      ok: false,
      reason: "invalid-json",
    });

    stubFetch(() => json(200, okGoogle('{"findings":[]}', { finishReason: "SAFETY" })));
    expect(await callGoogle(fakeGoogleEp(), MODEL, msgs(), opts())).toMatchObject({
      ok: false,
      reason: "content-filter",
    });
    expect(calls.length).toBe(1);

    // Other non-STOP finish reasons (e.g. RECITATION) also skip, never retried.
    stubFetch(() => json(200, okGoogle('{"findings":[]}', { finishReason: "RECITATION" })));
    expect(await callGoogle(fakeGoogleEp(), MODEL, msgs(), opts())).toMatchObject({
      ok: false,
      reason: "content-filter",
    });
    expect(calls.length).toBe(1);

    stubFetch(() => json(200, okGoogle('{"findings":[]}')));
    expect(await callGoogle(fakeGoogleEp(), MODEL, msgs(), opts())).toEqual({ ok: true, findings: [] });
  });

  it("promptFeedback.blockReason with empty candidates → content-filter skip, no retry", async () => {
    stubFetch(() => json(200, { promptFeedback: { blockReason: "SAFETY" }, candidates: [] }));
    expect(await callGoogle(fakeGoogleEp(), MODEL, msgs(), opts())).toMatchObject({
      ok: false,
      reason: "content-filter",
    });
    expect(calls.length).toBe(1);
  });

  it("retries once on 429/5xx and degrades on timeout without retry", async () => {
    // 429 → one retry (Retry-After: 0 keeps the backoff instant).
    stubFetch((_c, n) =>
      n === 1 ? json(429, { error: "rate limited" }, { "retry-after": "0" }) : json(200, okGoogle('{"findings":[]}')),
    );
    expect(await callGoogle(fakeGoogleEp(), MODEL, msgs(), opts())).toEqual({ ok: true, findings: [] });
    expect(calls.length).toBe(2);

    // Persistent 5xx → exactly one retry (two calls, never three).
    stubFetch(() => json(503, { error: "unavailable" }, { "retry-after": "0" }));
    expect(await callGoogle(fakeGoogleEp(), MODEL, msgs(), opts())).toMatchObject({
      ok: false,
      reason: "http-error",
    });
    expect(calls.length).toBe(2);

    // Timeout → degrade without any retry.
    const timeoutFetch = vi.fn(
      (url: string | URL, init: RequestInit) =>
        new Promise<Response>((_res, rej) => {
          calls.push({ url: String(url), init });
          init.signal?.addEventListener("abort", () => rej(new Error("aborted")));
        }),
    );
    vi.stubGlobal("fetch", timeoutFetch);
    calls = [];
    expect(await callGoogle(fakeGoogleEp(), MODEL, msgs(), { ...opts(), timeoutSeconds: 0.05 })).toMatchObject({
      ok: false,
      reason: "timeout",
    });
    expect(timeoutFetch).toHaveBeenCalledTimes(1);
    expect(calls.length).toBe(1);
  });

  it("persistent 5xx http-error detail redacts the API key", async () => {
    const key = "sk-secret-123";
    stubFetch(() => json(500, { error: `boom ${key}` }, { "retry-after": "0" }));
    const r = await callGoogle(fakeGoogleEp(key), MODEL, msgs(), { ...opts(), apiKey: key });
    expect(r).toMatchObject({ ok: false, reason: "http-error" });
    expect((r as { detail: string }).detail).toContain("[REDACTED]");
    expect((r as { detail: string }).detail).not.toContain(key);
    // 5xx → exactly one retry, then the plain http-error path (no schema fallback for 5xx).
    expect(calls.length).toBe(2);
  });
});
