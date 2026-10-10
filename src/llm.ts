import type { Finding } from "./fastpath.js";
import { PR_REVIEW_SCHEMA } from "./prompt.js";
import type { ResolvedEndpoint } from "./providers.js";

export class InvalidJsonError extends Error {}
export class OllamaMissingError extends Error {}

/** OpenAI reasoning models (strict family, and the max_completion_tokens family). */
const OPENAI_REASONING_RE = /\bo\d|gpt-5|gpt-6/i;
/** Claude version token: major, then an optional 1–2 digit minor not followed by another digit (so dates are never read as minors). */
const CLAUDE_VERSION_RE = /claude[^\d]*(\d+)(?:[.-](\d{1,2})(?!\d))?/i;
/** Providers that accept the full strict json_schema shape. */
const FULL_SCHEMA_PROVIDERS: ReadonlySet<string> = new Set(["openai", "opencode-zen", "opencode-go"]);

const REQUEST_TIMEOUT_HEALTH_MS = 10_000;
const RETRY_BACKOFF_MS = 500;
const MAX_RETRY_AFTER_MS = 5_000;
const SNIPPET_CHARS = 200;

export type LlmResult =
  | { ok: true; findings: Finding[] }
  | {
      ok: false;
      reason: "no-key" | "unsupported" | "timeout" | "content-filter" | "invalid-json" | "http-error";
      detail: string;
    };

type ResponseFormat = { type: "json_schema"; json_schema: typeof PR_REVIEW_SCHEMA } | { type: "json_object" };

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * STRICT family (sampling params rejected unless at defaults):
 * OpenAI reasoning models, or Claude major >= 5, or Claude 4.7 and later.
 * Claude 4.0–4.6, Claude 3.x and dated ids are not strict.
 */
function isStrictFamily(model: string): boolean {
  if (OPENAI_REASONING_RE.test(model)) return true;
  const m = CLAUDE_VERSION_RE.exec(model);
  if (m === null) return false;
  const major = Number(m[1]);
  const minor = m[2] === undefined ? 0 : Number(m[2]);
  return major >= 5 || (major === 4 && minor >= 7);
}

function isAnthropicCompat(provider: string, apiStyle?: string): boolean {
  return provider === "anthropic" || apiStyle === "anthropic-messages";
}

export function validateSampling(o: {
  model: string;
  temperature?: number;
  topP?: number;
  n?: number;
  provider: string;
  apiStyle?: string;
}): void {
  const anthropic = isAnthropicCompat(o.provider, o.apiStyle);

  if (isStrictFamily(o.model)) {
    const explicit =
      (o.temperature !== undefined && o.temperature !== 1) ||
      o.topP !== undefined ||
      (o.n !== undefined && o.n !== 1);
    if (explicit) {
      throw new Error(
        anthropic
          ? `Model "${o.model}" is a reasoning model: Anthropic-compat rejects temperature, top_p and n (HTTP 400). Remove them.`
          : `Model "${o.model}" is a reasoning model: temperature, top_p and n must be left at their defaults. Remove them.`,
      );
    }
    return;
  }

  if (anthropic) {
    if (o.n !== undefined && o.n !== 1) {
      throw new Error(`Anthropic-compat supports only n=1; n must be 1 or unset`);
    }
    if (o.temperature !== undefined && o.topP !== undefined) {
      throw new Error(`temperature and top_p cannot be set together on Anthropic-compat`);
    }
    if (o.temperature !== undefined && !(o.temperature >= 0 && o.temperature <= 1)) {
      throw new Error(`temperature must be between 0 and 1`);
    }
    if (o.topP !== undefined && !(o.topP >= 0 && o.topP <= 1)) {
      throw new Error(`top_p must be between 0 and 1`);
    }
  }
}

/** OpenAI reasoning only. Claude always uses max_tokens (Anthropic API). */
export function tokenFieldFor(model: string): "max_completion_tokens" | "max_tokens" {
  return OPENAI_REASONING_RE.test(model) ? "max_completion_tokens" : "max_tokens";
}

/** Strips a surrounding ```json or bare ``` fence, then parses. */
export function parseContent(raw: string): unknown {
  const stripped = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  try {
    return JSON.parse(stripped);
  } catch {
    throw new InvalidJsonError("model content is not valid JSON");
  }
}

const SEVERITIES: ReadonlySet<unknown> = new Set(["info", "warning", "high"]);

/**
 * Hand-written structural check against PR_REVIEW_SCHEMA's required fields.
 * Returns undefined when the response is invalid. Line is coerced rather than
 * rejected: only an integer >= 1 is kept, anything else becomes undefined.
 */
function toFindings(v: unknown): Finding[] | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const list = (v as { findings?: unknown }).findings;
  if (!Array.isArray(list)) return undefined;
  const out: Finding[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) return undefined;
    const i = item as Record<string, unknown>;
    if (!SEVERITIES.has(i.severity)) return undefined;
    if (typeof i.file !== "string" || typeof i.rule !== "string" || typeof i.message !== "string") return undefined;
    if (!(i.suggestion === null || typeof i.suggestion === "string")) return undefined;
    const f: Finding = {
      severity: i.severity as Finding["severity"],
      file: i.file,
      rule: i.rule,
      message: i.message,
    };
    if (Number.isInteger(i.line) && (i.line as number) >= 1) f.line = i.line as number;
    if (typeof i.suggestion === "string") f.suggestion = i.suggestion;
    out.push(f);
  }
  return out;
}

function responseFormatFor(provider: string): ResponseFormat | undefined {
  if (FULL_SCHEMA_PROVIDERS.has(provider)) return { type: "json_schema", json_schema: PR_REVIEW_SCHEMA };
  if (provider === "anthropic") return undefined;
  return { type: "json_object" };
}

function redact(text: string, key: string): string {
  return text.split(key).join("[REDACTED]");
}

function retryDelayMs(raw: string | null): number {
  const secs = raw === null ? NaN : Number(raw);
  if (!Number.isFinite(secs)) return RETRY_BACKOFF_MS;
  return Math.min(Math.max(secs, 0) * 1000, MAX_RETRY_AFTER_MS);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Attempt =
  | { kind: "fail"; result: LlmResult }
  | { kind: "response"; status: number; ok: boolean; retryAfter: string | null; text: string };

/**
 * One HTTP attempt. The abort timer covers the headers AND the body read, and is
 * cleared only after the body is fully read.
 */
async function attempt(ep: ResolvedEndpoint, payload: string, o: { timeoutSeconds: number; apiKey: string }): Promise<Attempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), o.timeoutSeconds * 1000);
  try {
    const res = await fetch(`${ep.baseUrl}${ep.path}`, {
      method: "POST",
      headers: { ...ep.headers, "Content-Type": "application/json" },
      body: payload,
      signal: controller.signal,
    });
    const text = await res.text();
    return { kind: "response", status: res.status, ok: res.ok, retryAfter: res.headers.get("retry-after"), text };
  } catch (e) {
    if (controller.signal.aborted) {
      return { kind: "fail", result: { ok: false, reason: "timeout", detail: `no complete response within ${o.timeoutSeconds}s` } };
    }
    return {
      kind: "fail",
      result: { ok: false, reason: "http-error", detail: redact(`request failed: ${errMessage(e)}`, o.apiKey) },
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function callLlm(
  ep: ResolvedEndpoint,
  messages: { system: string; user: string },
  o: {
    model: string;
    apiKey: string;
    temperature?: number;
    topP?: number;
    maxTokens: number;
    timeoutSeconds: number;
    provider: string;
  },
): Promise<LlmResult> {
  const key = o.apiKey;
  if (key === "") return { ok: false, reason: "no-key", detail: "no API key configured" };

  const anthropic = isAnthropicCompat(o.provider);
  try {
    validateSampling({ model: o.model, temperature: o.temperature, topP: o.topP, provider: o.provider });
  } catch (e) {
    return { ok: false, reason: "unsupported", detail: redact(errMessage(e), key) };
  }

  const body: Record<string, unknown> = {
    model: o.model,
    messages: [
      { role: "system", content: messages.system },
      { role: "user", content: messages.user },
    ],
    [tokenFieldFor(o.model)]: o.maxTokens,
  };
  const rf = responseFormatFor(o.provider);
  if (rf !== undefined) body.response_format = rf;
  if (!anthropic) {
    if (o.temperature !== undefined) body.temperature = o.temperature;
    if (o.topP !== undefined) body.top_p = o.topP;
  }
  const payload = JSON.stringify(body);

  let a = await attempt(ep, payload, o);
  if (a.kind === "fail") return a.result;
  // Retry once on 429 or 5xx only; the delay honors Retry-After (clamped).
  if (a.status === 429 || a.status >= 500) {
    await sleep(retryDelayMs(a.retryAfter));
    a = await attempt(ep, payload, o);
    if (a.kind === "fail") return a.result;
  }

  if (!a.ok) {
    const snippet = redact(a.text, key).slice(0, SNIPPET_CHARS);
    return { ok: false, reason: "http-error", detail: `HTTP ${a.status}${snippet ? `: ${snippet}` : ""}` };
  }

  let json: unknown;
  try {
    json = JSON.parse(a.text);
  } catch {
    return { ok: false, reason: "invalid-json", detail: "response body is not JSON" };
  }
  const choice = (json as { choices?: Array<{ finish_reason?: string; message?: Record<string, unknown> }> } | null)
    ?.choices?.[0];
  const msg = choice?.message;

  // Refusal is honored everywhere except Anthropic-compat (which never sends it).
  // Pinned union: a refusal maps to "content-filter".
  if (!anthropic && typeof msg?.refusal === "string" && msg.refusal !== "") {
    return { ok: false, reason: "content-filter", detail: "model refused the request" };
  }
  // Pinned union: provider content filtering maps to "content-filter".
  if (choice?.finish_reason === "content_filter") {
    return { ok: false, reason: "content-filter", detail: "provider content filter stopped the response" };
  }
  // Pinned union has no "length" member: truncation degrades as "invalid-json" (no diff-shrink retry).
  if (choice?.finish_reason === "length") {
    return { ok: false, reason: "invalid-json", detail: "response truncated (finish_reason=length)" };
  }
  if (typeof msg?.content !== "string") {
    return { ok: false, reason: "invalid-json", detail: "response has no content" };
  }

  let parsed: unknown;
  try {
    parsed = parseContent(msg.content);
  } catch (e) {
    return { ok: false, reason: "invalid-json", detail: errMessage(e) };
  }
  const findings = toFindings(parsed);
  if (findings === undefined) {
    return { ok: false, reason: "invalid-json", detail: "response does not match the review schema" };
  }
  return { ok: true, findings };
}

/**
 * Healthchecks the Ollama server at the root (baseUrl minus trailing /v1),
 * then pulls `model` through the REST API. A 404 from pull throws
 * OllamaMissingError.
 */
export async function ensureOllama(baseUrl: string, model: string): Promise<void> {
  const root = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  let health: Response;
  try {
    health = await fetch(`${root}/`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_HEALTH_MS) });
  } catch (e) {
    throw new Error(`Ollama is not reachable at ${root}: ${errMessage(e)}`);
  }
  await health.text().catch(() => "");
  if (!health.ok) {
    throw new Error(`Ollama is not reachable at ${root} (HTTP ${health.status})`);
  }

  const pull = await fetch(`${root}/api/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, stream: false }),
  });
  if (pull.status === 404) {
    await pull.text().catch(() => "");
    throw new OllamaMissingError(`Ollama model "${model}" is not installed and could not be pulled`);
  }
  if (!pull.ok) {
    await pull.text().catch(() => "");
    throw new Error(`ollama pull "${model}" failed with HTTP ${pull.status}`);
  }
  const body = (await pull.json().catch(() => undefined)) as { error?: unknown } | undefined;
  if (body?.error) {
    throw new Error(`ollama pull "${model}" failed: ${String(body.error)}`);
  }
}
