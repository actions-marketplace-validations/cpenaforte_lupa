import * as core from "@actions/core";

export type FailLevel = "none" | "warning" | "high";

export const LLM_PROVIDERS = [
  "openai",
  "anthropic",
  "google",
  "groq",
  "mistral",
  "openrouter",
  "ollama",
  "opencode-zen",
  "opencode-go",
  "custom",
] as const;

export const LLM_API_STYLES = [
  "auto",
  "openai-chat",
  "openai-responses",
  "anthropic-messages",
  "google-models",
  "custom-path",
] as const;

export interface ActionInputs {
  githubToken: string;
  llmProvider: string;
  llmBaseUrl: string;
  llmApiStyle: string;
  llmPath: string;
  llmModel: string;
  llmApiKey: string;
  llmTemperature?: number;
  llmTopP?: number;
  llmMaxTokens: number;
  failLevel: FailLevel;
  maxDiffChars: number;
  postComment: boolean;
  timeoutSeconds: number;
  prNumber: number | null;
}

export function parseFailLevel(v: string): FailLevel {
  if (v === "none" || v === "warning" || v === "high") return v;
  throw new Error(`Invalid fail_level "${v}": expected none, warning, or high`);
}

function readString(name: string, fallback = ""): string {
  const v = core.getInput(name).trim();
  return v === "" ? fallback : v;
}

function readInt(name: string, fallback: number): number {
  const raw = readString(name);
  if (raw === "") return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid ${name} "${raw}": expected a non-negative integer`);
  }
  return Number(raw);
}

function readOptionalNumber(name: string): number | undefined {
  const raw = readString(name);
  if (raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid ${name} "${raw}": expected a number`);
  }
  return n;
}

function readBool(name: string, fallback: boolean): boolean {
  const raw = readString(name);
  if (raw === "") return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`Invalid ${name} "${raw}": expected true or false`);
}

function readEnum<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const raw = readString(name);
  if (raw === "") return fallback;
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  throw new Error(`Invalid ${name} "${raw}": expected one of ${allowed.join(", ")}`);
}

export function getInputs(): ActionInputs {
  const llmTemperature = readOptionalNumber("llm_temperature");
  const llmTopP = readOptionalNumber("llm_top_p");
  const prRaw = readString("pr_number");
  let prNumber: number | null = null;
  if (prRaw !== "") {
    if (!/^\d+$/.test(prRaw) || Number(prRaw) < 1) {
      throw new Error(`Invalid pr_number "${prRaw}": expected a positive integer`);
    }
    prNumber = Number(prRaw);
  }

  return {
    githubToken: readString("github_token"),
    llmProvider: readEnum("llm_provider", LLM_PROVIDERS, "openai"),
    llmBaseUrl: readString("llm_base_url"),
    llmApiStyle: readEnum("llm_api_style", LLM_API_STYLES, "auto"),
    llmPath: readString("llm_path"),
    llmModel: readString("llm_model"),
    llmApiKey: readString("llm_api_key"),
    ...(llmTemperature !== undefined ? { llmTemperature } : {}),
    ...(llmTopP !== undefined ? { llmTopP } : {}),
    llmMaxTokens: readInt("llm_max_tokens", 2000),
    failLevel: parseFailLevel(readString("fail_level", "warning")),
    maxDiffChars: readInt("max_diff_chars", 60000),
    postComment: readBool("post_comment", true),
    timeoutSeconds: readInt("timeout_seconds", 90),
    prNumber,
  };
}
