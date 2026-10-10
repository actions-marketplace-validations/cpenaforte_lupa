import type { ResolvedEndpoint } from "../providers.js";
import {
  attempt,
  errMessage,
  parseContent,
  redact,
  retryDelayMs,
  sleep,
  toFindings,
  validateSampling,
  SNIPPET_CHARS,
  type LlmResult,
} from "../llm.js";

/** Concatenates `text` blocks from the response's `content[]` array. */
function joinContentText(json: unknown): string | undefined {
  const content = (json as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return undefined;
  const texts: string[] = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const p = part as { type?: unknown; text?: unknown };
    if (p.type === "text" && typeof p.text === "string") texts.push(p.text);
  }
  return texts.length > 0 ? texts.join("") : undefined;
}

/**
 * Anthropic Messages API (`POST {base}/messages`): `{model, max_tokens, system,
 * messages}` in, `content[]` out. Auth is `x-api-key` + `anthropic-version`
 * (never `Authorization`); sampling params are never sent by default (Claude
 * 4.7+ rejects them), `stop_reason` maps refusal→content-filter and
 * max_tokens→degrade, and there is no structured-output format to fall back from.
 */
export async function callMessages(
  ep: ResolvedEndpoint,
  messages: { system: string; user: string },
  o: {
    model: string;
    apiKey: string;
    temperature?: number;
    topP?: number;
    maxTokens: number;
    timeoutSeconds: number;
  },
): Promise<LlmResult> {
  const key = o.apiKey;
  if (key === "") return { ok: false, reason: "no-key", detail: "no API key configured" };

  try {
    // Hardcoded "anthropic": like callResponses, the signature carries no provider — the
    // Anthropic-compat sampling rules only need the anthropic family check.
    validateSampling({ model: o.model, temperature: o.temperature, topP: o.topP, provider: "anthropic" });
  } catch (e) {
    return { ok: false, reason: "unsupported", detail: redact(errMessage(e), key) };
  }

  // NEVER temperature/top_p/n/response_format by default: like openai-responses, only
  // explicitly configured sampling rides along (post-validateSampling); n and
  // response_format are never sent.
  const body: Record<string, unknown> = {
    model: o.model,
    // max_tokens is REQUIRED on every /messages call, including reasoning models.
    max_tokens: o.maxTokens,
    system: messages.system,
    messages: [{ role: "user", content: messages.user }],
  };
  if (o.temperature !== undefined) body.temperature = o.temperature;
  if (o.topP !== undefined) body.top_p = o.topP;
  const payload = JSON.stringify(body);

  // Spec §9.2 auth: x-api-key + anthropic-version; the endpoint only lends its
  // User-Agent/session headers (Authorization is not part of this protocol).
  const headers: Record<string, string> = {
    ...ep.headers,
    "x-api-key": key,
    "anthropic-version": "2023-06-01",
  };
  // Case-insensitive strip: Authorization is not part of this protocol, whatever its casing.
  for (const k of Object.keys(headers)) {
    if (/^authorization$/i.test(k)) delete headers[k];
  }
  const authEp: ResolvedEndpoint = { baseUrl: ep.baseUrl, path: ep.path, headers, apiStyle: ep.apiStyle };

  let a = await attempt(authEp, payload, o);
  if (a.kind === "fail") return a.result;
  // Retry once on 429 or 5xx only; the delay honors Retry-After (clamped).
  if (a.status === 429 || a.status >= 500) {
    await sleep(retryDelayMs(a.retryAfter));
    a = await attempt(authEp, payload, o);
    if (a.kind === "fail") return a.result;
  }

  if (!a.ok) {
    const snippet = redact(a.text, key).slice(0, SNIPPET_CHARS);
    return { ok: false, reason: "http-error", detail: `HTTP ${a.status}${snippet ? `: ${snippet}` : ""}`, status: a.status };
  }

  let json: unknown;
  try {
    json = JSON.parse(a.text);
  } catch {
    return { ok: false, reason: "invalid-json", detail: "response body is not JSON" };
  }

  const stopReason = (json as { stop_reason?: unknown } | null)?.stop_reason;
  // Refusal is honored natively here (the fixed set of failure reasons has no refusal entry).
  if (stopReason === "refusal") {
    return { ok: false, reason: "content-filter", detail: "model refused the request" };
  }
  // The fixed set of failure reasons has no "length" entry: truncation degrades as "invalid-json" (no diff-shrink retry).
  if (stopReason === "max_tokens") {
    return { ok: false, reason: "invalid-json", detail: "response truncated (stop_reason=max_tokens)" };
  }

  const text = joinContentText(json);
  if (text === undefined) {
    return { ok: false, reason: "invalid-json", detail: "response has no content" };
  }

  let parsed: unknown;
  try {
    parsed = parseContent(text);
  } catch (e) {
    return { ok: false, reason: "invalid-json", detail: errMessage(e) };
  }
  const findings = toFindings(parsed);
  if (findings === undefined) {
    return { ok: false, reason: "invalid-json", detail: "response does not match the review schema" };
  }
  return { ok: true, findings };
}
