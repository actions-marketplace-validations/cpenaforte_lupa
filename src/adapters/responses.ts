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

/** Every `{type, ...}` block inside `output[].content[]`. */
function outputParts(json: unknown): Array<Record<string, unknown>> {
  const output = (json as { output?: unknown } | null)?.output;
  if (!Array.isArray(output)) return [];
  const parts: Array<Record<string, unknown>> = [];
  for (const item of output) {
    const content = (item as { content?: unknown } | null)?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (typeof part === "object" && part !== null) parts.push(part as Record<string, unknown>);
    }
  }
  return parts;
}

function hasRefusal(json: unknown): boolean {
  return outputParts(json).some(
    (p) => p.type === "refusal" && typeof p.refusal === "string" && p.refusal !== "",
  );
}

/** Joins `output_text` (or plain `text`) parts across all output items. */
function joinOutputText(json: unknown): string | undefined {
  const texts = outputParts(json)
    .filter((p) => (p.type === "output_text" || p.type === "text") && typeof p.text === "string")
    .map((p) => p.text as string);
  return texts.length > 0 ? texts.join("") : undefined;
}

/**
 * OpenAI Responses API (`POST {base}/responses`): `{model, input, max_output_tokens,
 * text.format}` in, `output[].content[]` out. Same LlmResult union as the chat
 * caller: refusal reads as content-filter, `incomplete` degrades like `length`,
 * and a 400 on the strict format retries once without it (manual parse).
 */
export async function callResponses(
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
    validateSampling({ model: o.model, temperature: o.temperature, topP: o.topP, provider: "openai" });
  } catch (e) {
    return { ok: false, reason: "unsupported", detail: redact(errMessage(e), key) };
  }

  const buildBody = (withFormat: boolean): Record<string, unknown> => {
    const body: Record<string, unknown> = {
      model: o.model,
      input: [
        { role: "system", content: messages.system },
        { role: "user", content: messages.user },
      ],
      // The Responses API always budgets output via max_output_tokens,
      // including reasoning models (no max_completion_tokens here).
      max_output_tokens: o.maxTokens,
    };
    if (withFormat) {
      body.text = {
        format: {
          type: "json_schema",
          name: PR_REVIEW_SCHEMA.name,
          schema: PR_REVIEW_SCHEMA.schema,
          strict: PR_REVIEW_SCHEMA.strict,
        },
      };
    }
    if (o.temperature !== undefined) body.temperature = o.temperature;
    if (o.topP !== undefined) body.top_p = o.topP;
    return body;
  };

  let payload = JSON.stringify(buildBody(true));

  let a = await attempt(ep, payload, o);
  if (a.kind === "fail") return a.result;
  // Structured-output fallback: a 400 on the strict format retries once
  // without `text`, then the raw text is parsed manually.
  if (!a.ok && a.status === 400) {
    payload = JSON.stringify(buildBody(false));
    a = await attempt(ep, payload, o);
    if (a.kind === "fail") return a.result;
  }
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

  // A refusal is reported as "content-filter" (the fixed set of failure reasons has no refusal entry).
  if (hasRefusal(json)) {
    return { ok: false, reason: "content-filter", detail: "model refused the request" };
  }
  // The fixed set of failure reasons has no "incomplete" entry: truncation degrades as "invalid-json" (no diff-shrink retry).
  if ((json as { status?: unknown } | null)?.status === "incomplete") {
    return { ok: false, reason: "invalid-json", detail: "response truncated (status=incomplete)" };
  }

  const text = joinOutputText(json);
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
