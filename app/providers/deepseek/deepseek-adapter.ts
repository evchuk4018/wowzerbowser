import "server-only";

import type {
  ChatModelInfo,
  ChatRequest,
  ChatStreamEvent,
  ChatUsage,
} from "../../../lib/chat-protocol";
import { DEFAULT_CHAT_MODELS } from "../../../lib/chat-protocol";

const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

type DeepSeekModelResponse = {
  data?: Array<{ id?: unknown }>;
};

type DeepSeekChunk = {
  choices?: Array<{
    delta?: {
      reasoning_content?: unknown;
      content?: unknown;
    };
  }>;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
    completion_tokens_details?: { reasoning_tokens?: unknown };
  } | null;
};

export class DeepSeekError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
}

let cachedModels: { expiresAt: number; models: ChatModelInfo[] } | null = null;

function getApiKey(): string {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) throw new DeepSeekError("DeepSeek is not configured.", 503);
  return apiKey;
}

export function assertDeepSeekConfigured(): void {
  getApiKey();
}

function headers(): HeadersInit {
  return {
    authorization: `Bearer ${getApiKey()}`,
    "content-type": "application/json",
  };
}

function usageFromChunk(value: DeepSeekChunk["usage"]): ChatUsage | null {
  if (!value || typeof value !== "object") return null;

  const numberOrUndefined = (candidate: unknown) =>
    typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;

  const usage: ChatUsage = {
    promptTokens: numberOrUndefined(value.prompt_tokens),
    completionTokens: numberOrUndefined(value.completion_tokens),
    totalTokens: numberOrUndefined(value.total_tokens),
    reasoningTokens: numberOrUndefined(value.completion_tokens_details?.reasoning_tokens),
  };

  return Object.values(usage).some((item) => item !== undefined) ? usage : null;
}

function parseChunk(data: string): ChatStreamEvent[] {
  if (data === "[DONE]") return [{ type: "done", usage: null }];

  let chunk: DeepSeekChunk;
  try {
    chunk = JSON.parse(data) as DeepSeekChunk;
  } catch {
    return [];
  }

  const delta = chunk.choices?.[0]?.delta;
  const events: ChatStreamEvent[] = [];
  if (typeof delta?.reasoning_content === "string" && delta.reasoning_content) {
    events.push({ type: "reasoning", delta: delta.reasoning_content });
  }
  if (typeof delta?.content === "string" && delta.content) {
    events.push({ type: "content", delta: delta.content });
  }
  const usage = usageFromChunk(chunk.usage);
  if (usage) events.push({ type: "done", usage });
  return events;
}

async function* parseSse(response: Response): AsyncGenerator<ChatStreamEvent> {
  if (!response.body) throw new DeepSeekError("DeepSeek returned an empty stream.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";

      for (const block of blocks) {
        const data = block
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");
        if (!data) continue;

        for (const event of parseChunk(data)) {
          if (event.type === "done" && data === "[DONE]") completed = true;
          yield event;
        }
      }

      if (done) break;
    }

    if (buffer.trim()) {
      const data = buffer
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (data) {
        for (const event of parseChunk(data)) {
          if (event.type === "done" && data === "[DONE]") completed = true;
          yield event;
        }
      }
    }
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
  }
}

export async function* streamDeepSeekChat(
  request: ChatRequest,
  signal?: AbortSignal,
): AsyncGenerator<ChatStreamEvent> {
  const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: headers(),
    signal,
    body: JSON.stringify({
      model: request.model,
      messages: [
        { role: "system", content: request.systemPrompt },
        ...(request.userPresence
          ? [{ role: "system" as const, content: request.userPresence }]
          : []),
        ...request.messages,
      ],
      stream: true,
      thinking: { type: request.thinking ? "enabled" : "disabled" },
      ...(request.thinking ? { reasoning_effort: request.reasoningEffort } : {}),
    }),
  });

  if (!response.ok) {
    const providerMessage = await response.text().catch(() => "");
    throw new DeepSeekError(
      providerMessage.slice(0, 240) || `DeepSeek request failed (${response.status}).`,
      response.status >= 400 && response.status < 500 ? response.status : 502,
    );
  }

  yield* parseSse(response);
}

export async function listDeepSeekModels(): Promise<ChatModelInfo[]> {
  if (cachedModels && cachedModels.expiresAt > Date.now()) return cachedModels.models;

  try {
    const response = await fetch(`${DEEPSEEK_BASE_URL}/models`, { headers: headers() });
    if (!response.ok) throw new Error("Model discovery failed.");
    const body = (await response.json()) as DeepSeekModelResponse;
    const availableIds = new Set(
      (body.data ?? []).filter((item) => typeof item.id === "string").map((item) => item.id),
    );
    const models = DEFAULT_CHAT_MODELS.filter((model) => availableIds.has(model.id));
    cachedModels = {
      expiresAt: Date.now() + MODEL_CACHE_TTL_MS,
      models: models.length ? models : DEFAULT_CHAT_MODELS,
    };
    return cachedModels.models;
  } catch {
    return DEFAULT_CHAT_MODELS;
  }
}
