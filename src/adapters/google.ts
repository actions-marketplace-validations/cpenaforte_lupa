import { PR_REVIEW_SCHEMA } from "../prompt.js";
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

/** candidates[0] as an object, when present. */
function firstCandidate(json: unknown): Record<string, unknown> | undefined {
  const candidates = (json as { candidates?: unknown } | null)?.candidates;
  if (!Array.isArray(candidates)) return undefined;
  const c = candidates[0];
  return typeof c === "object" && c !== null ? (c as Record<string, unknown>) : undefined;
}

/** promptFeedback.blockReason when set (Gemini prompt-level blocks, often with empty candidates). */
function promptBlockReason(json: unknown): string | undefined {
  const feedback = (json as { promptFeedback?: unknown } | null)?.promptFeedback;
  if (typeof feedback !== "object" || feedback === null) return undefined;
  const r = (feedback as { blockReason?: unknown }).blockReason;
  return typeof r === "string" && r !== "" ? r : undefined;
}

/** Joins `text` blocks from `candidates[0].content.parts[]`. */
function joinCandidateText(json: unknown): string | undefined {
  const candidate = firstCandidate(json);
  const content = candidate?.content;
  if (typeof content !== "object" || content === null) return undefined;
  const parts = (content as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return undefined;
  const texts: string[] = [];
  for (const part of parts) {
    if (typeof part !== "object" || part === null) continue;
    const t = (part as { text?: unknown }).text;
    if (typeof t === "string") texts.push(t);
  }
  return texts.length > 0 ? texts.join("") : undefined;
}

/**
 * Converts the strict OpenAI-style schema subset used by PR_REVIEW_SCHEMA to
 * Google's OpenAPI-subset for `responseSchema`:
 * - `type: ["integer", "null"]` becomes `type: "integer", nullable: true`;
 * - `additionalProperties` is dropped (unsupported there), at every level;
 * - `required` is filtered to the properties the schema actually defines, so
 *   it stays valid;
 * - `properties` and `items` are converted recursively; everything else is
 *   copied as is. The caller keeps the retry-without-schema fallback as safety.
 */
export function googleSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "additionalProperties") continue;
    if (k === "type" && Array.isArray(v)) {
      const types = v.filter((t): t is string => typeof t === "string" && t !== "null");
      if (v.includes("null")) out.nullable = true;
      if (types.length > 0) out.type = types[0];
      continue;
    }
    if (k === "properties" && typeof v === "object" && v !== null && !Array.isArray(v)) {
      const props: Record<string, unknown> = {};
      for (const [name, sub] of Object.entries(v as Record<string, unknown>)) {
        props[name] =
          typeof sub === "object" && sub !== null && !Array.isArray(sub)
            ? googleSchema(sub as Record<string, unknown>)
            : sub;
      }
      out.properties = props;
      continue;
    }
    if (k === "items" && typeof v === "object" && v !== null && !Array.isArray(v)) {
      out.items = googleSchema(v as Record<string, unknown>);
      continue;
    }
    out[k] = v;
  }
  if (Array.isArray(out.required) && typeof out.properties === "object" && out.properties !== null) {
    const props = out.properties as Record<string, unknown>;
    const required = (out.required as unknown[]).filter((n) => typeof n === "string" && n in props);
    if (required.length > 0) out.required = required;
    else delete out.required;
  }
  return out;
}

/**
 * Google generateContent (`POST {base}/models/<id>:generateContent`): the body is
 * `{contents, systemInstruction, generationConfig}` with `maxOutputTokens` for the
 * token budget. Structured output rides as `responseMimeType`+`responseSchema`; a 400
 * on it retries once without both (manual parse, like callResponses). Prompt-level
 * blocks (`promptFeedback.blockReason`) and `finishReason` SAFETY/any other non-STOP
 * value map to a content-filter skip without retry; MAX_TOKENS degrades. Auth prefers
 * the `x-goog-api-key` header: the key never rides the URL (`?key=` is never appended
 * by default) and is never logged.
 */
export async function callGoogle(
  ep: ResolvedEndpoint,
  modelId: string,
  messages: { system: string; user: string },
  o: {
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
    // Hardcoded "google": like callResponses/callMessages the signature carries no
    // provider, and validateSampling only needs the family check for strict rules.
    validateSampling({ model: modelId, temperature: o.temperature, topP: o.topP, provider: "google" });
  } catch (e) {
    return { ok: false, reason: "unsupported", detail: redact(errMessage(e), key) };
  }

  const buildBody = (withSchema: boolean): Record<string, unknown> => {
    const generationConfig: Record<string, unknown> = { maxOutputTokens: o.maxTokens };
    if (withSchema) {
      generationConfig.responseMimeType = "application/json";
      generationConfig.responseSchema = googleSchema(PR_REVIEW_SCHEMA.schema);
    }
    if (o.temperature !== undefined) generationConfig.temperature = o.temperature;
    if (o.topP !== undefined) generationConfig.topP = o.topP;
    return {
      contents: [{ role: "user", parts: [{ text: messages.user }] }],
      systemInstruction: { parts: [{ text: messages.system }] },
      generationConfig,
    };
  };

  let payload = JSON.stringify(buildBody(true));

  // Spec §9.3 auth: prefer the x-goog-api-key header; the endpoint only lends its
  // User-Agent/session headers (Authorization is not part of this protocol, and
  // the query-string `?key=` fallback is never used by default — never logged).
  const headers: Record<string, string> = {
    ...ep.headers,
    "x-goog-api-key": key,
  };
  // Case-insensitive strip: Authorization is not part of this protocol, whatever its casing.
  for (const k of Object.keys(headers)) {
    if (/^authorization$/i.test(k)) delete headers[k];
  }
  const authEp: ResolvedEndpoint = { baseUrl: ep.baseUrl, path: ep.path, headers, apiStyle: ep.apiStyle };

  let a = await attempt(authEp, payload, o);
  if (a.kind === "fail") return a.result;
  // Structured-output fallback: a 400 on responseSchema retries once without it
  // (and without responseMimeType), then the raw text is parsed manually.
  if (!a.ok && a.status === 400) {
    payload = JSON.stringify(buildBody(false));
    a = await attempt(authEp, payload, o);
    if (a.kind === "fail") return a.result;
  }
  // Retry once on 429 or 5xx only; the delay honors Retry-After (clamped).
  if (a.status === 429 || a.status >= 500) {
    await sleep(retryDelayMs(a.retryAfter));
    a = await attempt(authEp, payload, o);
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

  // A prompt-level block (e.g. SAFETY) is a provider-side skip, never retried —
  // it arrives as promptFeedback.blockReason, usually with no candidates at all.
  const blockReason = promptBlockReason(json);
  if (blockReason !== undefined) {
    return {
      ok: false,
      reason: "content-filter",
      detail: `provider blocked the prompt (blockReason=${blockReason})`,
    };
  }

  const finishReason = firstCandidate(json)?.finishReason;
  // The fixed set of failure reasons has no "length" entry: truncation degrades
  // as "invalid-json" (no diff-shrink retry).
  if (finishReason === "MAX_TOKENS") {
    return { ok: false, reason: "invalid-json", detail: "response truncated (finishReason=MAX_TOKENS)" };
  }
  // SAFETY and every other non-STOP finish reason is a provider-side skip, never retried
  // (reported as content-filter: the fixed set of failure reasons has no refusal entry).
  if (finishReason !== undefined && finishReason !== "STOP") {
    return {
      ok: false,
      reason: "content-filter",
      detail: `provider stopped the response (finishReason=${String(finishReason)})`,
    };
  }

  const text = joinCandidateText(json);
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
