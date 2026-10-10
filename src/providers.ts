import * as core from "@actions/core";
import type { ActionInputs, LlmApiStyle } from "./inputs.js";

export class UnsupportedModelError extends Error {}

/** Same six members as LlmApiStyle in inputs.ts (identical union). */
export type ApiStyle = LlmApiStyle;

/** API styles that need a non-chat body adapter (v2 only). */
export type NonChatStyle = Exclude<ApiStyle, "auto" | "openai-chat" | "custom-path">;

/**
 * What a resolved endpoint actually speaks: "auto" is resolved away, and
 * "custom-path" (path-only override) resolves to the openai-chat body.
 */
export type ResolvedApiStyle = "openai-chat" | NonChatStyle;

export interface ResolvedEndpoint {
  /** Base URL only; never includes the request path. */
  baseUrl: string;
  /** Request path appended to baseUrl, e.g. "/chat/completions". */
  path: string;
  headers: Record<string, string>;
  /** Resolved API style: the dispatcher in llm.ts picks the adapter by this. */
  apiStyle: ResolvedApiStyle;
}

/**
 * Presets provide base URLs only. Paths are chosen by the resolved API style.
 */
const PRESET_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta/openai",
  groq: "https://api.groq.com/openai/v1",
  mistral: "https://api.mistral.ai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  ollama: "http://localhost:11434/v1",
  "opencode-zen": "https://opencode.ai/zen/v1",
  "opencode-go": "https://opencode.ai/zen/go/v1",
};

const CHAT_PATH = "/chat/completions";
const USER_AGENT = "pr-reviewer/1.0";
/** Timeout for the GET {base}/models existence check. */
const VALIDATE_TIMEOUT_MS = 15_000;

/**
 * Provider:model pairs that are NOT served by the OpenAI chat-completions
 * endpoint. `auto` resolves these pairs to their adapter (v2: no more
 * fail-fast), and so does an explicit v2 `llm_api_style`. Explicit
 * `openai-chat` on one of these pairs still throws UnsupportedModelError
 * (chat cannot serve them). Chat-supported pairs (e.g. opencode-zen:qwen3.8-max)
 * must NOT appear here.
 *
 * Go per-model limits (documented for operators, enforced by the provider):
 * 5h window 20%, weekly 50%, monthly 100%, per-model caps $15–60.
 * When a Go subscription limit is hit, the Zen balance is used as fallback
 * by the provider; this action does not switch providers on its own.
 */
export const NON_CHAT: ReadonlyMap<string, NonChatStyle> = new Map<string, NonChatStyle>([
  // opencode-go
  ["opencode-go:qwen3.8-max", "anthropic-messages"],
  ["opencode-go:qwen3.8-flash", "anthropic-messages"],
  ["opencode-go:qwen3.7-max", "anthropic-messages"],
  ["opencode-go:qwen3.7-plus", "anthropic-messages"],
  ["opencode-go:minimax-m3", "anthropic-messages"],
  ["opencode-go:minimax-m2.7", "anthropic-messages"],
  ["opencode-go:claude-haiku-5-5", "anthropic-messages"],
  ["opencode-go:claude-sonnet-5-5", "anthropic-messages"],
  ["opencode-go:claude-opus-5-5", "anthropic-messages"],
  ["opencode-go:grok-4.7", "openai-responses"],
  ["opencode-go:grok-4.6", "openai-responses"],
  ["opencode-go:gpt-6-luna", "openai-responses"],
  ["opencode-go:gpt-5.6-luna", "openai-responses"],
  ["opencode-go:gpt-6.1-sol", "openai-responses"],
  ["opencode-go:gpt-6-astra", "openai-responses"],
  ["opencode-go:muse-spark-1.3-contributor", "openai-responses"],
  ["opencode-go:gemini-3.8-flash", "google-models"],
  ["opencode-go:gemini-3.5-flash-lite", "google-models"],
  // opencode-zen
  ["opencode-zen:gpt-6-luna", "openai-responses"],
  ["opencode-zen:gpt-6.1-sol", "openai-responses"],
  ["opencode-zen:gpt-6-astra", "openai-responses"],
  ["opencode-zen:grok-4.7", "openai-responses"],
  ["opencode-zen:grok-4.6", "openai-responses"],
  ["opencode-zen:claude-haiku-5-5", "anthropic-messages"],
  ["opencode-zen:claude-sonnet-5-5", "anthropic-messages"],
  ["opencode-zen:claude-opus-5-5", "anthropic-messages"],
  ["opencode-zen:qwen3.7-max", "anthropic-messages"],
  ["opencode-zen:qwen3.7-plus", "anthropic-messages"],
  ["opencode-zen:gemini-3.8-flash", "google-models"],
  ["opencode-zen:gemini-3.5-flash-lite", "google-models"],
]);

/** Last path segments that identify a non-chat endpoint (path-only misuse). */
const NON_CHAT_PATH_SEGMENTS: ReadonlySet<string> = new Set(["messages", "responses", "models"]);

/**
 * Contract: the caller passes a path that is already normalized (leading "/")
 * and already cleaned (no query or #fragment). This helper only trims trailing
 * slashes and checks whether the LAST segment is exactly messages, responses,
 * or models.
 * `/v1/messages` → true; `/openai/models/chat/completions` → false.
 */
function isPathOnlyNonChat(path: string): boolean {
  const pathname = path.replace(/\/+$/, "");
  const last = pathname.slice(pathname.lastIndexOf("/") + 1);
  return NON_CHAT_PATH_SEGMENTS.has(last);
}

export interface ResolveEndpointOptions {
  llmProvider: ActionInputs["llmProvider"];
  llmBaseUrl: string;
  llmApiStyle: ActionInputs["llmApiStyle"];
  llmPath: string;
  llmModel: string;
  llmApiKey: string;
  prNumber: number | null;
}

/** Default request path for each resolved API style; llm_path overrides it. */
function defaultPathFor(apiStyle: ResolvedApiStyle, model: string): string {
  switch (apiStyle) {
    case "openai-responses":
      return "/responses";
    case "anthropic-messages":
      return "/messages";
    case "google-models":
      return `/models/${model}:generateContent`;
    case "openai-chat":
      return CHAT_PATH;
  }
}

export function resolveEndpoint(o: ResolveEndpointOptions): ResolvedEndpoint {
  const rawBase = o.llmBaseUrl || PRESET_BASE_URLS[o.llmProvider] || "";
  if (rawBase === "") {
    throw new Error(`llm_provider "${o.llmProvider}" requires llm_base_url`);
  }
  const baseUrl = rawBase.replace(/\/+$/, "");

  // custom-path requires an explicit llm_path; other styles default to their own path.
  if (o.llmApiStyle === "custom-path" && o.llmPath === "") {
    throw new Error(`llm_api_style "custom-path" requires llm_path`);
  }

  // Resolve the API style. `auto` consults the versioned (provider, model) map
  // and now RESOLVES non-chat pairs to their adapter; explicit v2 styles are
  // honored as-is (functional); openai-chat and custom-path use the chat body.
  let apiStyle: ResolvedApiStyle;
  if (o.llmApiStyle === "openai-responses" || o.llmApiStyle === "anthropic-messages" || o.llmApiStyle === "google-models") {
    apiStyle = o.llmApiStyle;
  } else if (o.llmApiStyle === "auto") {
    apiStyle = NON_CHAT.get(`${o.llmProvider}:${o.llmModel}`) ?? "openai-chat";
  } else {
    apiStyle = "openai-chat";
    if (o.llmApiStyle === "openai-chat") {
      const nonChat = NON_CHAT.get(`${o.llmProvider}:${o.llmModel}`);
      if (nonChat !== undefined) {
        throw new UnsupportedModelError(
          `Model "${o.llmModel}" on "${o.llmProvider}" is served by "${nonChat}", which openai-chat cannot reach. ` +
            `Set llm_api_style to auto (resolves it automatically) or "${nonChat}". ` +
            `Supported API styles: auto, openai-chat, openai-responses, anthropic-messages, google-models, custom-path.`,
        );
      }
    }
  }

  // The google preset base ends in the OpenAI-compat segment (/openai); the
  // native generateContent path hangs off the API root, so drop that segment.
  const effectiveBase =
    apiStyle === "google-models" && baseUrl.endsWith("/openai") ? baseUrl.slice(0, -"/openai".length) : baseUrl;
  // R3: surface the rewrite when it changes a USER-SUPPLIED custom base URL.
  if (effectiveBase !== baseUrl && o.llmBaseUrl !== "") {
    core.warning(
      `llm_base_url "${baseUrl}" rewritten to "${effectiveBase}": google-models needs the API root, not the OpenAI-compat "/openai" suffix`,
    );
  }

  const rawPath = o.llmPath !== "" ? o.llmPath : defaultPathFor(apiStyle, o.llmModel);
  // Normalize (leading slash), then strip query and fragment from the returned
  // path; the path-only guard runs on that same returned path.
  const normalized = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  const path = normalized.split(/[?#]/)[0];
  // Never echo the query or fragment (may carry secrets); name only the parts dropped.
  const strippedParts: string[] = [];
  if (normalized.includes("?")) strippedParts.push("query string");
  if (normalized.includes("#")) strippedParts.push("fragment");
  if (strippedParts.length > 0) {
    core.warning(`llm_path ${strippedParts.join(" and ")} ignored; only the path is used`);
  }
  // Path-only guard: a non-chat path needs a body adapter, which only a v2
  // style provides — with a v2 style active the adapter exists, so it is skipped.
  if (apiStyle === "openai-chat" && isPathOnlyNonChat(path)) {
    const rawClean = rawPath.split(/[?#]/)[0];
    throw new UnsupportedModelError(
      `llm_path "${rawClean}" normalizes to "${path}", which is path-only: it names a non-chat endpoint. ` +
        `llm_path only overrides the path; a non-chat body adapter requires a v2 llm_api_style ` +
        `(openai-responses, anthropic-messages or google-models).`,
    );
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${o.llmApiKey}`,
    "User-Agent": USER_AGENT,
  };
  if (o.llmProvider === "opencode-go" && o.prNumber !== null) {
    headers["x-opencode-session"] = `pr-${o.prNumber}`;
  }

  return { baseUrl: effectiveBase, path, headers, apiStyle };
}

/**
 * Auth header for the GET {base}/models existence check, derived from
 * provider + resolved style at the call site: Google-native endpoints
 * (provider `google` speaking the google-models protocol) use `x-goog-api-key`;
 * everything else — including Zen/Go catalog checks — keeps Bearer.
 */
export function authHeaderFor(provider: string, apiStyle: ResolvedApiStyle): { header: string } {
  return { header: provider === "google" && apiStyle === "google-models" ? "x-goog-api-key" : "Authorization" };
}

/**
 * Checks that `model` is listed by GET {baseUrl}/models. Checks id presence
 * only; never infers or changes the endpoint used for chat requests.
 * `auth.header` (see authHeaderFor) picks the auth header name; the default
 * keeps `Authorization: Bearer`. Non-2xx behavior is unchanged.
 *
 * - 2xx with a JSON `data` array: true iff some entry has id === model.
 * - 404: false (model list endpoint absent / model not found).
 * - Other non-2xx: throws, naming the HTTP status.
 * - Invalid JSON, or missing `data` array on 2xx: throws.
 * - Timeout (VALIDATE_TIMEOUT_MS) or network error: throws.
 */
export async function validateModelExists(
  baseUrl: string,
  model: string,
  apiKey: string,
  auth: { header?: string } = {},
): Promise<boolean> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  const headers: Record<string, string> = { "User-Agent": USER_AGENT };
  if (auth.header === "x-goog-api-key") {
    headers["x-goog-api-key"] = apiKey;
  } else {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VALIDATE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers,
      signal: controller.signal,
    });
    if (res.status === 404) {
      await res.body?.cancel().catch(() => undefined);
      return false;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`GET ${url} failed with HTTP ${res.status}`);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new Error(`GET ${url} returned invalid JSON`);
    }
    const data = (body as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) {
      throw new Error(`GET ${url} returned no "data" array`);
    }
    return data.some((m) => (m as { id?: unknown } | null)?.id === model);
  } finally {
    clearTimeout(timer);
  }
}
