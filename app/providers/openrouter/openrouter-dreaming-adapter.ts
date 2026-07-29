import "server-only";

import type { ChatUsage } from "../../../lib/chat-protocol";
import { parseDreamingActions, type DreamingAction } from "../../../lib/user-memory";
import {
  OPENROUTER_API_KEY,
  OPENROUTER_BASE_URL,
  OPENROUTER_DEEPSEEK_FLASH_MODEL,
  OPENROUTER_QWEN_FLASH_MODEL,
  openRouterHeaders,
} from "./openrouter-config";
import { OpenRouterError } from "./openrouter-catalog-adapter";

export const OPENROUTER_DREAMING_MODEL = OPENROUTER_QWEN_FLASH_MODEL;
export const DREAMING_TIMEOUT_MS = 30_000;

type DreamingResponse = {
  model?: unknown;
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: {
    prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown; cost?: unknown;
    prompt_tokens_details?: { cached_tokens?: unknown };
    completion_tokens_details?: { reasoning_tokens?: unknown };
  };
};

const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

function usage(value: DreamingResponse["usage"]): ChatUsage | null {
  if (!value) return null;
  const result = {
    promptTokens: number(value.prompt_tokens),
    completionTokens: number(value.completion_tokens),
    totalTokens: number(value.total_tokens),
    cachedPromptTokens: number(value.prompt_tokens_details?.cached_tokens),
    reasoningTokens: number(value.completion_tokens_details?.reasoning_tokens),
  };
  return Object.values(result).some((entry) => entry !== undefined) ? result : null;
}

function content(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value.map((part) =>
    part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : "",
  ).join("").trim();
}

export type DreamingAnswer = {
  actions: DreamingAction[];
  model: string;
  usage: ChatUsage | null;
  exactCostUsd?: number;
};

export async function consolidateUserMemoryWithQwen(
  prompt: string,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<DreamingAnswer> {
  if (!OPENROUTER_API_KEY) throw new OpenRouterError("OpenRouter dreaming is not configured.", 503);
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DREAMING_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: openRouterHeaders(),
      signal,
      body: JSON.stringify({
        models: [OPENROUTER_DREAMING_MODEL, OPENROUTER_DEEPSEEK_FLASH_MODEL],
        messages: [{ role: "user", content: prompt }],
        reasoning: { enabled: true },
        response_format: { type: "json_object" },
        max_tokens: 4_096,
      }),
    });
  } catch {
    if (options.signal?.aborted) throw new OpenRouterError("Dreaming was cancelled.", 499);
    if (timeout.aborted) throw new OpenRouterError("Dreaming timed out.", 504);
    throw new OpenRouterError("OpenRouter dreaming is unavailable.", 502);
  }
  if (!response.ok) {
    await response.text().catch(() => "");
    throw new OpenRouterError("OpenRouter rejected the dreaming request.", response.status >= 400 && response.status < 500 ? response.status : 502);
  }
  let payload: DreamingResponse;
  try { payload = await response.json() as DreamingResponse; }
  catch { throw new OpenRouterError("OpenRouter returned invalid dreaming JSON.", 502); }
  const raw = content(payload.choices?.[0]?.message?.content);
  if (!raw) throw new OpenRouterError("OpenRouter returned an empty dreaming response.", 502);
  let parsed: unknown;
  try { parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "")); }
  catch { throw new OpenRouterError("Qwen returned malformed dreaming actions.", 502); }
  return {
    actions: parseDreamingActions(parsed),
    model: typeof payload.model === "string" ? payload.model : OPENROUTER_DREAMING_MODEL,
    usage: usage(payload.usage),
    ...(number(payload.usage?.cost) === undefined ? {} : { exactCostUsd: number(payload.usage?.cost) }),
  };
}
