import "server-only";

import type { ChatUsage } from "../../../lib/chat-protocol";
import {
  OPENROUTER_IMAGE_TIMEOUT_MS,
  MAX_IMAGE_ANALYSIS_RESPONSE_LENGTH,
  type ChatImageContentType,
  ChatImageError,
} from "../../../lib/chat-image";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_IMAGE_MODEL = "openrouter/free";
export const PDF_PAGE_OCR_PROMPT = "Extract all visible text from this PDF page. Preserve reading order and line breaks where practical. Return only the text; do not describe the page, add markdown, or summarize.";

export type OpenRouterImageAnswer = {
  content: string;
  model: string | null;
  usage: ChatUsage | null;
};

export class OpenRouterImageError extends ChatImageError {
  constructor(code: string, message: string, status = 502) {
    super(code, message, status);
    this.name = "OpenRouterImageError";
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

function apiKey(): string {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) throw new OpenRouterImageError("missing_api_key", "Image understanding is not configured.", 503);
  return key;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function usageFromResponse(value: OpenRouterResponse["usage"]): ChatUsage | null {
  if (!value) return null;
  const usage: ChatUsage = {
    promptTokens: numberOrUndefined(value.prompt_tokens),
    completionTokens: numberOrUndefined(value.completion_tokens),
    totalTokens: numberOrUndefined(value.total_tokens),
    cachedPromptTokens: numberOrUndefined(value.prompt_tokens_details?.cached_tokens),
    reasoningTokens: numberOrUndefined(value.completion_tokens_details?.reasoning_tokens),
  };
  return Object.values(usage).some((item) => item !== undefined) ? usage : null;
}

function answerText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((part) => typeof part === "string" ? part : part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : "")
      .join("")
      .trim();
  }
  return "";
}

function safeProviderMessage(body: string, status: number): string {
  if (status === 429) return "Image understanding is rate limited. Please try again.";
  if (status === 404 || status === 400) return "No eligible free vision model is available right now.";
  return `Image understanding failed (${status}).`;
}

export type OpenRouterImageRequestOptions = {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export async function askOpenRouterAboutImage(
  question: string,
  bytes: Uint8Array,
  contentType: ChatImageContentType,
  options: OpenRouterImageRequestOptions = {},
): Promise<OpenRouterImageAnswer> {
  const key = apiKey();
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? OPENROUTER_IMAGE_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const body = {
    model: OPENROUTER_IMAGE_MODEL,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: question },
        { type: "image_url", image_url: { url: `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}` } },
      ],
    }],
  };
  let response: Response;
  try {
    response = await fetchImpl(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch {
    if (options.signal?.aborted) throw new OpenRouterImageError("cancelled", "Image analysis was cancelled.", 499);
    if (timeout.aborted) throw new OpenRouterImageError("timeout", "Image analysis timed out.", 504);
    throw new OpenRouterImageError("transport", "Image understanding is unavailable.", 502);
  }
  if (!response.ok) {
    await response.text().catch(() => "");
    const code = response.status === 429
      ? "rate_limit"
      : response.status === 408 || response.status >= 500
        ? "upstream"
        : response.status === 404 || response.status === 400
          ? "no_vision_model"
          : "provider_validation";
    throw new OpenRouterImageError(code, safeProviderMessage("", response.status), response.status);
  }
  let payload: OpenRouterResponse;
  try {
    payload = await response.json() as OpenRouterResponse;
  } catch {
    throw new OpenRouterImageError("malformed_response", "Image understanding returned an invalid response.");
  }
  const content = answerText(payload.choices?.[0]?.message?.content);
  if (!content) throw new OpenRouterImageError("empty_answer", "Image understanding returned an empty answer.");
  if (content.length > MAX_IMAGE_ANALYSIS_RESPONSE_LENGTH) {
    throw new OpenRouterImageError("answer_too_long", "Image understanding returned an answer that is too long.");
  }
  return {
    content,
    model: typeof payload.model === "string" && payload.model ? payload.model : null,
    usage: usageFromResponse(payload.usage),
  };
}

/**
 * OCR is intentionally a thin specialization of the existing image adapter.
 * Keeping transport, timeouts, safe provider errors, and cancellation in one
 * adapter prevents PDF ingestion from growing a second OpenRouter client.
 */
export async function askOpenRouterToOcrPdfPage(
  bytes: Uint8Array,
  options: Pick<OpenRouterImageRequestOptions, "signal" | "fetchImpl" | "timeoutMs"> = {},
): Promise<OpenRouterImageAnswer> {
  return askOpenRouterAboutImage(PDF_PAGE_OCR_PROMPT, bytes, "image/png", options);
}

export function assertOpenRouterConfigured(): void {
  apiKey();
}
