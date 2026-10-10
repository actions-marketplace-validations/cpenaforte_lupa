import type { Finding } from "./fastpath.js";
import { PR_REVIEW_SCHEMA } from "./prompt.js";
import type { ResolvedEndpoint } from "./providers.js";

export class InvalidJsonError extends Error {}
export class OllamaMissingError extends Error {}

/** STRICT family: sampling params are rejected unless at their defaults. */
const STRICT_RE = /\bo\d|gpt-5|gpt-6|claude.*4\.([7-9]|\d{2,})|claude.*[5-9]/i;
/** OpenAI reasoning models only (never Claude). */
const REASONING_RE = /\bo\d|gpt-5|gpt-6/i;
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

  if (STRICT_RE.test(o.model)) {
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

export function tokenFieldFor(model: string): "max_completion_tokens" | "max_tokens" {
  return REASONING_RE.test(model) ? "max_completion_tokens" : "max_tokens";
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

/** Hand-written structural check against PR_REVIEW_SCHEMA's required fields. */
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
    if (!(i.line === null || Number.isInteger(i.line))) return undefined;
    if (!(i.suggestion === null || typeof i.suggestion === "string")) return undefined;
    const f: Finding = {
      severity: i.severity as Finding["severity"],
      file: i.file,
      rule: i.rule,
      message: i.message,
    };
    if (i.line !== null) f.line = i.line as number;
    if (i.suggestion !== null) f.suggestion = i.suggestion as string;
    out.push(f);
  }
  return out;
}

function responseFormatFor(provider: string): unknown {
  if (FULL_SCHEMA_PROVIDERS.has(provider)) return { type: "json_schema", json_schema: PR_REVIEW_SCHEMA };
  if (provider === "anthropic") return undefined;
  return { type: "json_object" };
}

function redact(text: string, key: string): string {
  return key === "" ? text : text.split(key).join("[REDACTED]");
}

function retryDelayMs(res: Response): number {
  const raw = res.headers.get("retry-after");
  const secs = raw === null ? NaN : Number(raw);
  if (!Number.isFinite(secs)) return RETRY_BACKOFF_MS;
  return Math.min(Math.max(secs, 0) * 1000, MAX_RETRY_AFTER_MS);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
    return { ok: false, reason: "unsupported", detail: redact((e as Error).message, key) };
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

  const send = async (): Promise<Response | LlmResult> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), o.timeoutSeconds * 1000);
    try {
      return await fetch(`${ep.baseUrl}${ep.path}`, {
        method: "POST",
        headers: { ...ep.headers, "Content-Type": "application/json" },
        body: payload,
        signal: controller.signal,
      });
    } catch (e) {
      if (controller.signal.aborted) {
        return { ok: false, reason: "timeout", detail: `no response within ${o.timeoutSeconds}s` };
      }
      return { ok: false, reason: "http-error", detail: redact(`request failed: ${(e as Error).message}`, key) };
    } finally {
      clearTimeout(timer);
    }
  };

  let res = await send();
  if (!(res instanceof Response)) return res;
  if (res.status === 429 || res.status >= 500) {
    const delay = retryDelayMs(res);
    await res.body?.cancel().catch(() => undefined);
    await sleep(delay);
    const again = await send();
    if (!(again instanceof Response)) return again;
    res = again;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const snippet = redact(text.slice(0, SNIPPET_CHARS), key);
    return { ok: false, reason: "http-error", detail: `HTTP ${res.status}${snippet ? `: ${snippet}` : ""}` };
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { ok: false, reason: "invalid-json", detail: "response body is not JSON" };
  }
  const choice = (json as { choices?: Array<{ finish_reason?: string; message?: Record<string, unknown> }> } | null)
    ?.choices?.[0];
  const msg = choice?.message;

  if (!anthropic && typeof msg?.refusal === "string" && msg.refusal !== "") {
    return { ok: false, reason: "content-filter", detail: "model refused the request" };
  }
  if (choice?.finish_reason === "content_filter") {
    return { ok: false, reason: "content-filter", detail: "provider content filter stopped the response" };
  }
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
    return { ok: false, reason: "invalid-json", detail: (e as Error).message };
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
  const health = await fetch(`${root}/`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_HEALTH_MS) });
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
