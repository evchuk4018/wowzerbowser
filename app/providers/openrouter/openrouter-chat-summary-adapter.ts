import "server-only";

import {
  CHAT_SUMMARY_MAX_OUTPUT_TOKENS,
  CHAT_SUMMARY_TIMEOUT_MS,
  type ChatSummaryAnswer,
} from "../../../lib/chat-summary";

export const OPENROUTER_CHAT_SUMMARY_MODEL = "openrouter/free";
const BASE_URL = "https://openrouter.ai/api/v1";

export type OpenRouterChatSummaryErrorCode =
  | "missing_api_key"
  | "cancelled"
  | "timeout"
  | "transport"
  | "rate_limit"
  | "upstream"
  | "provider_validation"
  | "malformed_response"
  | "empty_answer";

export class OpenRouterChatSummaryError extends Error {
  constructor(
    readonly code: OpenRouterChatSummaryErrorCode,
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "OpenRouterChatSummaryError";
  }
}

type OpenRouterResponse = {
  model?: unknown;
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
    prompt_tokens_details?: { cached_tokens?: unknown };
    completion_tokens_details?: { reasoning_tokens?: unknown };
  } | null;
};

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function usageFromResponse(value: OpenRouterResponse["usage"]): ChatSummaryAnswer["usage"] {
  if (!value) return null;
  const usage = {
    promptTokens: numberOrUndefined(value.prompt_tokens),
    completionTokens: numberOrUndefined(value.completion_tokens),
    totalTokens: numberOrUndefined(value.total_tokens),
    cachedPromptTokens: numberOrUndefined(value.prompt_tokens_details?.cached_tokens),
    reasoningTokens: numberOrUndefined(value.completion_tokens_details?.reasoning_tokens),
  };
  return Object.values(usage).some((item) => item !== undefined) ? usage : null;
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value.map((part) => {
    if (typeof part === "string") return part;
    return part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : "";
  }).join("").trim();
}

function apiKey(): string {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) {
    throw new OpenRouterChatSummaryError(
      "missing_api_key",
      "OpenRouter chat summarization is not configured.",
      503,
      false,
    );
  }
  return key;
}

function providerError(status: number): OpenRouterChatSummaryError {
  if (status === 429) {
    return new OpenRouterChatSummaryError("rate_limit", "OpenRouter chat summarization is rate limited.", status, true);
  }
  if (status === 408 || status >= 500) {
    return new OpenRouterChatSummaryError("upstream", "OpenRouter chat summarization is temporarily unavailable.", status, true);
  }
  return new OpenRouterChatSummaryError("provider_validation", "OpenRouter rejected the chat summarization request.", status, false);
}

export type OpenRouterChatSummaryOptions = {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export async function summarizeChatWithOpenRouter(
  prompt: string,
  options: OpenRouterChatSummaryOptions = {},
): Promise<ChatSummaryAnswer> {
  const key = apiKey();
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? CHAT_SUMMARY_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const body = {
    model: OPENROUTER_CHAT_SUMMARY_MODEL,
    messages: [{ role: "user", content: prompt }],
    max_tokens: CHAT_SUMMARY_MAX_OUTPUT_TOKENS,
  };

  let response: Response;
  try {
    response = await fetchImpl(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch {
    if (options.signal?.aborted) {
      throw new OpenRouterChatSummaryError("cancelled", "Chat summarization was cancelled.", 499, false);
    }
    if (timeout.aborted) {
      throw new OpenRouterChatSummaryError("timeout", "Chat summarization timed out.", 504, true);
    }
    throw new OpenRouterChatSummaryError("transport", "OpenRouter chat summarization is unavailable.", 502, true);
  }

  if (!response.ok) {
    await response.text().catch(() => "");
    throw providerError(response.status);
  }

  let payload: OpenRouterResponse;
  try {
    payload = await response.json() as OpenRouterResponse;
  } catch {
    throw new OpenRouterChatSummaryError("malformed_response", "OpenRouter returned an invalid chat summary response.", 502, true);
  }

  const summary = textOf(payload.choices?.[0]?.message?.content);
  if (!summary) {
    throw new OpenRouterChatSummaryError("empty_answer", "OpenRouter returned an empty chat summary.", 502, true);
  }

  return {
    summary,
    provider: "openrouter",
    model: typeof payload.model === "string" && payload.model ? payload.model : OPENROUTER_CHAT_SUMMARY_MODEL,
    usage: usageFromResponse(payload.usage),
  };
}

