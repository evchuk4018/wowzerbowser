import "server-only";

import { CHAT_SUMMARY_MAX_OUTPUT_TOKENS, CHAT_SUMMARY_TIMEOUT_MS, type ChatSummaryAnswer } from "../../../lib/chat-summary";
import { DEEPSEEK_BASE_URL, deepSeekHeaders } from "./deepseek-client-config";
import { DeepSeekError } from "./deepseek-error";

export const DEEPSEEK_CHAT_SUMMARY_MODEL = "deepseek-v4-flash";

type ResponseBody = {
  model?: unknown;
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown; prompt_tokens_details?: { cached_tokens?: unknown }; completion_tokens_details?: { reasoning_tokens?: unknown } } | null;
};

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function usageFromResponse(value: ResponseBody["usage"]): ChatSummaryAnswer["usage"] {
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

export type DeepSeekChatSummaryOptions = { signal?: AbortSignal; fetchImpl?: typeof fetch; timeoutMs?: number };

export async function summarizeChatWithDeepSeek(prompt: string, options: DeepSeekChatSummaryOptions = {}): Promise<ChatSummaryAnswer> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? CHAT_SUMMARY_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: deepSeekHeaders(),
      body: JSON.stringify({ model: DEEPSEEK_CHAT_SUMMARY_MODEL, messages: [{ role: "user", content: prompt }], thinking: { type: "disabled" }, max_tokens: CHAT_SUMMARY_MAX_OUTPUT_TOKENS }),
      signal,
    });
  } catch {
    if (options.signal?.aborted) throw new DeepSeekError("Chat summarization was cancelled.", 499);
    if (timeout.aborted) throw new DeepSeekError("Chat summarization timed out.", 504);
    throw new DeepSeekError("DeepSeek chat summarization is unavailable.", 502);
  }
  if (!response.ok) {
    await response.text().catch(() => "");
    throw new DeepSeekError("DeepSeek rejected the chat summarization request.", response.status >= 400 && response.status < 500 ? response.status : 502);
  }
  let payload: ResponseBody;
  try { payload = await response.json() as ResponseBody; } catch { throw new DeepSeekError("DeepSeek returned an invalid chat summary response.", 502); }
  const summary = textOf(payload.choices?.[0]?.message?.content);
  if (!summary) throw new DeepSeekError("DeepSeek returned an empty chat summary.", 502);
  return { summary, provider: "deepseek", model: typeof payload.model === "string" && payload.model ? payload.model : DEEPSEEK_CHAT_SUMMARY_MODEL, usage: usageFromResponse(payload.usage) };
}
