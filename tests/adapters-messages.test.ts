import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { callMessages } from "../src/adapters/messages.js";
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

/** Minimal Messages-API envelope carrying one text block. */
const okMessages = (text: string, extra: Record<string, unknown> = {}) => ({
  type: "message",
  role: "assistant",
  content: [{ type: "text", text }],
  stop_reason: "end_turn",
  ...extra,
});

function lastBody(): Record<string, unknown> {
  return JSON.parse(String(calls.at(-1)!.init.body)) as Record<string, unknown>;
}

/** Endpoint mirroring resolveEndpoint for the messages path. */
function fakeMessagesEp(key = "k"): ResolvedEndpoint {
  return {
    baseUrl: "https://api.anthropic.com/v1",
    path: "/messages",
    headers: {
      Authorization: `Bearer ${key}`,
      authorization: `Bearer ${key}`,
      "User-Agent": "pr-reviewer/1.0",
      "x-opencode-session": "pr-123",
    },
  };
}

function msgs(): { system: string; user: string } {
  return { system: "s", user: '{"findings":[]}' };
}

function opts() {
  return { model: "claude-sonnet-5-5", apiKey: "k", maxTokens: 50, timeoutSeconds: 5 };
}

beforeEach(() => {
  calls = [];
  stubFetch(() => json(200, okMessages('{"findings":[]}')));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------- tests ----------

describe("callMessages", () => {
  it("posts exact {model, max_tokens, system, messages} body with x-api-key + anthropic-version headers", async () => {
    const r = await callMessages(fakeMessagesEp(), msgs(), opts());
    expect(r).toEqual({ ok: true, findings: [] });
    expect(calls.at(-1)!.url).toBe("https://api.anthropic.com/v1/messages");
    const headers = calls.at(-1)!.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("k");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["User-Agent"]).toBe("pr-reviewer/1.0");
    expect(headers["x-opencode-session"]).toBe("pr-123");
    // Deliberate: the Messages protocol authenticates via x-api-key only (any casing).
    expect(headers.Authorization).toBeUndefined();
    expect(headers["authorization"]).toBeUndefined();
    expect(lastBody()).toEqual({
      model: "claude-sonnet-5-5",
      max_tokens: 50,
      system: "s",
      messages: [{ role: "user", content: '{"findings":[]}' }],
    });
  });

  it("omits temperature, top_p, n and response_format by default", async () => {
    await callMessages(fakeMessagesEp(), msgs(), opts());
    const body = lastBody();
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("top_p");
    expect(body).not.toHaveProperty("n");
    expect(body).not.toHaveProperty("response_format");
  });

  it("joins content[].text blocks and parses findings", async () => {
    stubFetch(() =>
      json(200, {
        type: "message",
        role: "assistant",
        content: [
          { type: "thinking", thinking: "…" },
          { type: "text", text: '{"findings":[' },
          { type: "text", text: "]}" },
        ],
        stop_reason: "end_turn",
      }),
    );
    expect(await callMessages(fakeMessagesEp(), msgs(), opts())).toEqual({ ok: true, findings: [] });
  });

  it("stop_reason end_turn→ok; max_tokens→degrade; refusal→content-filter skip", async () => {
    stubFetch(() => json(200, okMessages('{"findings":[]}', { stop_reason: "max_tokens" })));
    expect(await callMessages(fakeMessagesEp(), msgs(), opts())).toMatchObject({
      ok: false,
      reason: "invalid-json",
    });

    stubFetch(() => json(200, { type: "message", content: [], stop_reason: "refusal" }));
    expect(await callMessages(fakeMessagesEp(), msgs(), opts())).toMatchObject({
      ok: false,
      reason: "content-filter",
    });

    stubFetch(() => json(200, okMessages('{"findings":[]}', { stop_reason: "end_turn" })));
    expect(await callMessages(fakeMessagesEp(), msgs(), opts())).toEqual({ ok: true, findings: [] });
  });

  it("retries once on 429/5xx and degrades on timeout without retry", async () => {
    // 429 → one retry (Retry-After: 0 keeps the backoff instant).
    stubFetch((_c, n) =>
      n === 1
        ? json(429, { error: "rate limited" }, { "retry-after": "0" })
        : json(200, okMessages('{"findings":[]}')),
    );
    expect(await callMessages(fakeMessagesEp(), msgs(), opts())).toEqual({ ok: true, findings: [] });
    expect(calls.length).toBe(2);

    // Persistent 5xx → exactly one retry (two calls, never three).
    stubFetch(() => json(503, { error: "unavailable" }, { "retry-after": "0" }));
    expect(await callMessages(fakeMessagesEp(), msgs(), opts())).toMatchObject({
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
    expect(
      await callMessages(fakeMessagesEp(), msgs(), { ...opts(), timeoutSeconds: 0.05 }),
    ).toMatchObject({ ok: false, reason: "timeout" });
    expect(timeoutFetch).toHaveBeenCalledTimes(1);
    expect(calls.length).toBe(1);
  });

  it("persistent 5xx http-error detail redacts the API key", async () => {
    const key = "sk-secret-123";
    stubFetch(() => json(500, { error: `boom ${key}` }, { "retry-after": "0" }));
    const r = await callMessages(fakeMessagesEp(key), msgs(), { ...opts(), apiKey: key });
    expect(r).toMatchObject({ ok: false, reason: "http-error" });
    expect((r as { detail: string }).detail).toContain("[REDACTED]");
    expect((r as { detail: string }).detail).not.toContain(key);
    // 5xx → exactly one retry, then the plain http-error path.
    expect(calls.length).toBe(2);
  });

  it("rejects explicit sampling on strict Claude via validateSampling", async () => {
    const r = await callMessages(fakeMessagesEp(), msgs(), {
      ...opts(),
      model: "claude-opus-5-5",
      temperature: 0.2,
    });
    expect(r).toMatchObject({ ok: false, reason: "unsupported" });
    expect(calls.length).toBe(0);
  });
});
