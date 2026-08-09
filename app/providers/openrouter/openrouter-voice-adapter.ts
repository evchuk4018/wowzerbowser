import "server-only";

import type { ChatUsage } from "../../../lib/chat-protocol";
import {
  CHAT_VOICE_FORMAT,
  MAX_CHAT_VOICE_TRANSCRIPT_CHARACTERS,
  OPENROUTER_VOICE_TIMEOUT_MS,
  type ChatVoiceAnswer,
} from "../../../lib/chat-voice";
import { OPENROUTER_BASE_URL, openRouterApiKey, openRouterHeaders } from "./openrouter-config";
import { OpenRouterError } from "./openrouter-catalog-adapter";

export const OPENROUTER_VOICE_MODELS = [
  "openrouter/auto",
  "mistralai/voxtral-small-24b-2507",
] as const;

export const OPENROUTER_VOICE_TRANSCRIPTION_PROMPT = [
  "Transcribe the supplied audio accurately.",
  "Return only the spoken words, without commentary, labels, markdown, or quotation marks.",
  "Preserve the speaker's wording and meaningful punctuation.",
].join(" ");

type ResponseUsage = {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  total_tokens?: unknown;
  prompt_tokens_details?: { cached_tokens?: unknown };
  completion_tokens_details?: { reasoning_tokens?: unknown };
  cost?: unknown;
};

type ResponseBody = {
  model?: unknown;
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: ResponseUsage | null;
};

function numberOrUndefined(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function usageFromResponse(value: ResponseUsage | null | undefined): ChatUsage | null {
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

function responseText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value.map((part) => {
    if (typeof part === "string") return part;
    return part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : "";
  }).join("").trim();
}

function safeError(status: number): string {
  if (status === 401 || status === 403) return "Voice transcription provider authentication failed.";
  if (status === 402) return "Voice transcription credits are exhausted.";
  if (status === 429) return "Voice transcription is temporarily rate limited. Please try again shortly.";
  if (status === 400 || status === 404 || status === 422) return "No configured voice transcription model accepted this recording.";
  if (status === 408 || status >= 500) return "Voice transcription providers are temporarily unavailable.";
  return `Voice transcription failed (${status}).`;
}

export type OpenRouterVoiceOptions = {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export async function transcribeWithOpenRouter(
  bytes: Uint8Array,
  options: OpenRouterVoiceOptions = {},
): Promise<ChatVoiceAnswer> {
  if (!openRouterApiKey()) throw new OpenRouterError("OpenRouter voice transcription is not configured.", 503);
  const timeout = AbortSignal.timeout(options.timeoutMs ?? OPENROUTER_VOICE_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const body = {
    models: [...OPENROUTER_VOICE_MODELS],
    messages: [{
      role: "user",
      content: [
        { type: "text", text: OPENROUTER_VOICE_TRANSCRIPTION_PROMPT },
        { type: "input_audio", input_audio: { data: Buffer.from(bytes).toString("base64"), format: CHAT_VOICE_FORMAT } },
      ],
    }],
    stream: false,
  };
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: openRouterHeaders(),
      body: JSON.stringify(body),
      signal,
    });
  } catch {
    if (options.signal?.aborted) throw new OpenRouterError("Voice transcription was cancelled.", 499);
    if (timeout.aborted) throw new OpenRouterError("Voice transcription timed out.", 504);
    throw new OpenRouterError("Voice transcription is unavailable.", 502);
  }
  if (!response.ok) throw new OpenRouterError(safeError(response.status), response.status >= 500 ? 502 : response.status);
  let payload: ResponseBody;
  try {
    payload = await response.json() as ResponseBody;
  } catch {
    throw new OpenRouterError("Voice transcription returned malformed JSON.", 502);
  }
  const transcript = responseText(payload.choices?.[0]?.message?.content);
  if (!transcript) throw new OpenRouterError("Voice transcription returned an empty response.", 502);
  if (transcript.length > MAX_CHAT_VOICE_TRANSCRIPT_CHARACTERS) throw new OpenRouterError("Voice transcription returned too much text.", 502);
  return {
    transcript,
    model: typeof payload.model === "string" && payload.model ? payload.model : OPENROUTER_VOICE_MODELS[0],
    usage: usageFromResponse(payload.usage),
    ...(numberOrUndefined(payload.usage?.cost) === undefined ? {} : { exactCostUsd: numberOrUndefined(payload.usage?.cost) }),
  };
}
