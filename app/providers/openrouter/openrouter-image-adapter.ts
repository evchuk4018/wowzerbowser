import "server-only";

import type { ChatUsage } from "../../../lib/chat-protocol";
import {
  OPENROUTER_IMAGE_TIMEOUT_MS,
  MAX_IMAGE_ANALYSIS_RESPONSE_LENGTH,
  type ChatImageContentType,
  ChatImageError,
} from "../../../lib/chat-image";
import {
  OPENROUTER_BASE_URL,
  OPENROUTER_IMAGE_MODELS,
  OPENROUTER_AUTO_MODEL,
} from "./openrouter-config";

export { OPENROUTER_BASE_URL } from "./openrouter-config";
export const OPENROUTER_IMAGE_MODEL = OPENROUTER_AUTO_MODEL;
export const PDF_PAGE_OCR_PROMPT = "Extract all visible text from this PDF page. Preserve reading order and line breaks where practical. Return only the text; do not describe the page, add markdown, or summarize.";

export type OpenRouterImageAnswer = {
  content: string;
  model: string | null;
  usage: ChatUsage | null;
  exactCostUsd?: number;
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
  error?: {
    code?: unknown;
    message?: unknown;
    metadata?: { error_type?: unknown };
  };
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
    prompt_tokens_details?: { cached_tokens?: unknown };
    completion_tokens_details?: { reasoning_tokens?: unknown };
    cost?: unknown;
  } | null;
};

function apiKey(): string {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) throw new OpenRouterImageError("missing_api_key", "Image understanding is not configured.", 503);
  return key;
}

function numberOrUndefined(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
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

function safeProviderMessage(status: number, errorType?: string): string {
  if (status === 402 || errorType === "payment_required") return "Image understanding credits are exhausted.";
  if (status === 429 || errorType === "rate_limit_exceeded") return "Image understanding is temporarily rate limited. Please try again shortly.";
  if (status === 502 || status === 503 || errorType === "provider_overloaded" || errorType === "provider_unavailable") {
    return "Image understanding providers are temporarily unavailable.";
  }
  if (status === 413 || errorType === "image_too_large") return "The image is too large for the image understanding provider.";
  if (errorType === "invalid_image" || errorType === "unsupported_image_format") {
    return "The image understanding provider could not read this image.";
  }
  if (status === 404 || status === 400 || status === 422) return "No configured image understanding model accepted this image.";
  if (status === 401 || status === 403) return "Image understanding provider authentication failed.";
  return `Image understanding failed (${status}).`;
}

export type OpenRouterImageRequestOptions = {
  model?: string | null;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retryDelayMs?: number;
};

type OpenRouterImageRequest = {
  prompt: string;
  bytes: Uint8Array;
  contentType: ChatImageContentType;
  responseFormat?: Record<string, unknown>;
};

function errorCode(status: number, errorType?: string): string {
  if (status === 402 || errorType === "payment_required") return "credits_exhausted";
  if (status === 429 || errorType === "rate_limit_exceeded") return "rate_limit";
  if (status === 408 || status >= 500 || errorType === "provider_overloaded" || errorType === "provider_unavailable") return "upstream";
  if (status === 404 || status === 400 || status === 422) return "no_vision_model";
  if (errorType?.startsWith("image_") || errorType === "unsupported_image_format") return "invalid_image";
  return "provider_validation";
}

function retryAfterMs(response: Response): number | null {
  const value = response.headers.get("retry-after")?.trim();
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

async function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason;
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function readProviderError(response: Response): Promise<string | undefined> {
  try {
    const payload = await response.json() as OpenRouterResponse;
    const errorType = payload.error?.metadata?.error_type;
    return typeof errorType === "string" ? errorType : undefined;
  } catch {
    return undefined;
  }
}

async function requestOpenRouterImage(
  request: OpenRouterImageRequest,
  options: OpenRouterImageRequestOptions,
): Promise<OpenRouterResponse> {
  const key = apiKey();
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? OPENROUTER_IMAGE_TIMEOUT_MS;
  const deadlineAt = Date.now() + timeoutMs;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const body = {
    ...(options.model ? { model: options.model } : { models: [...OPENROUTER_IMAGE_MODELS] }),
    messages: [{
      role: "user",
      content: [
        { type: "text", text: request.prompt },
        { type: "image_url", image_url: { url: `data:${request.contentType};base64,${Buffer.from(request.bytes).toString("base64")}` } },
      ],
    }],
    ...(request.responseFormat
      ? {
          response_format: request.responseFormat,
          provider: { require_parameters: true },
        }
      : {}),
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
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
    if (response.ok) {
      try {
        return await response.json() as OpenRouterResponse;
      } catch {
        throw new OpenRouterImageError("malformed_response", "Image understanding returned an invalid response.");
      }
    }

    const delayMs = retryAfterMs(response) ?? options.retryDelayMs ?? 500;
    const canRetry = attempt === 0
      && (response.status === 429 || response.status === 503)
      && Date.now() + delayMs < deadlineAt;
    if (canRetry) {
      await response.body?.cancel().catch(() => undefined);
      try {
        await waitForRetry(delayMs, signal);
      } catch {
        if (options.signal?.aborted) throw new OpenRouterImageError("cancelled", "Image analysis was cancelled.", 499);
        throw new OpenRouterImageError("timeout", "Image analysis timed out.", 504);
      }
      continue;
    }
    const errorType = await readProviderError(response);
    throw new OpenRouterImageError(errorCode(response.status, errorType), safeProviderMessage(response.status, errorType), response.status);
  }
  throw new OpenRouterImageError("upstream", "Image understanding providers are temporarily unavailable.", 503);
}

export async function askOpenRouterAboutImage(
  question: string,
  bytes: Uint8Array,
  contentType: ChatImageContentType,
  options: OpenRouterImageRequestOptions = {},
): Promise<OpenRouterImageAnswer> {
  const payload = await requestOpenRouterImage({ prompt: question, bytes, contentType }, options);
  const content = answerText(payload.choices?.[0]?.message?.content);
  if (!content) throw new OpenRouterImageError("empty_answer", "Image understanding returned an empty answer.");
  if (content.length > MAX_IMAGE_ANALYSIS_RESPONSE_LENGTH) {
    throw new OpenRouterImageError("answer_too_long", "Image understanding returned an answer that is too long.");
  }
  return {
    content,
    model: typeof payload.model === "string" && payload.model ? payload.model : null,
    usage: usageFromResponse(payload.usage),
    ...(numberOrUndefined(payload.usage?.cost) !== undefined ? { exactCostUsd: numberOrUndefined(payload.usage?.cost) } : {}),
  };
}

export type OpenRouterImageAnalysis = {
  visibleText: string | null;
  mainVisuals: string;
  model: string | null;
  usage: ChatUsage | null;
  exactCostUsd?: number;
};

const IMAGE_ANALYSIS_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "image_analysis",
    strict: true,
    schema: {
      type: "object",
      properties: {
        visibleText: {
          anyOf: [{ type: "string" }, { type: "null" }],
          description: "A faithful transcription of visible text, or null when no text is visible.",
        },
        mainVisuals: {
          type: "string",
          description: "A concise description of the main visible subjects, objects, interface elements, chart elements, or scene components.",
        },
      },
      required: ["visibleText", "mainVisuals"],
      additionalProperties: false,
    },
  },
} as const;

export async function analyzeOpenRouterImage(
  prompt: string,
  bytes: Uint8Array,
  contentType: ChatImageContentType,
  options: OpenRouterImageRequestOptions = {},
): Promise<OpenRouterImageAnalysis> {
  const payload = await requestOpenRouterImage({
    prompt,
    bytes,
    contentType,
    responseFormat: IMAGE_ANALYSIS_RESPONSE_FORMAT,
  }, options);
  const content = answerText(payload.choices?.[0]?.message?.content);
  if (!content) throw new OpenRouterImageError("empty_answer", "Image understanding returned an empty answer.");
  let analysis: unknown;
  try {
    analysis = JSON.parse(content);
  } catch {
    throw new OpenRouterImageError("malformed_response", "Image understanding returned an invalid response.");
  }
  if (!analysis || typeof analysis !== "object" || Array.isArray(analysis)) {
    throw new OpenRouterImageError("malformed_response", "Image understanding returned an invalid response.");
  }
  const value = analysis as Record<string, unknown>;
  const visibleText = value.visibleText === "NONE" ? null : value.visibleText;
  if (!(visibleText === null || typeof visibleText === "string") || typeof value.mainVisuals !== "string") {
    throw new OpenRouterImageError("malformed_response", "Image understanding returned an invalid response.");
  }
  if (!value.mainVisuals.trim()) {
    throw new OpenRouterImageError("empty_answer", "Image understanding returned an empty answer.");
  }
  if (
    (typeof visibleText === "string" && visibleText.length > MAX_IMAGE_ANALYSIS_RESPONSE_LENGTH)
    || value.mainVisuals.length > MAX_IMAGE_ANALYSIS_RESPONSE_LENGTH
  ) {
    throw new OpenRouterImageError("answer_too_long", "Image understanding returned an answer that is too long.");
  }
  return {
    visibleText: typeof visibleText === "string" && visibleText.trim() ? visibleText.trim() : null,
    mainVisuals: value.mainVisuals.trim(),
    model: typeof payload.model === "string" && payload.model ? payload.model : null,
    usage: usageFromResponse(payload.usage),
    ...(numberOrUndefined(payload.usage?.cost) !== undefined ? { exactCostUsd: numberOrUndefined(payload.usage?.cost) } : {}),
  };
}

/**
 * OCR is intentionally a thin specialization of the existing image adapter.
 * Keeping transport, timeouts, safe provider errors, and cancellation in one
 * adapter prevents PDF ingestion from growing a second OpenRouter client.
 */
export async function askOpenRouterToOcrPdfPage(
  bytes: Uint8Array,
  options: OpenRouterImageRequestOptions = {},
): Promise<OpenRouterImageAnswer> {
  return askOpenRouterAboutImage(PDF_PAGE_OCR_PROMPT, bytes, "image/png", options);
}

export function assertOpenRouterConfigured(): void {
  apiKey();
}
