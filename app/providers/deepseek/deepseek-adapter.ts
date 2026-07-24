import "server-only";

import type {
  ChatModelInfo,
  ChatRequest,
  ChatStreamEvent,
  ChatToolCall,
  ChatUsage,
} from "../../../lib/chat-protocol";
import { DEFAULT_CHAT_MODELS } from "../../../lib/chat-protocol";

const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

export type DeepSeekMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      reasoning_content?: string;
      tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
    }
  | { role: "tool"; content: string; tool_call_id: string; name?: string };

export type DeepSeekToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type DeepSeekRoundOptions = {
  messages?: DeepSeekMessage[];
  tools?: DeepSeekToolDefinition[];
};

type DeepSeekModelResponse = { data?: Array<{ id?: unknown }> };
type DeepSeekChunk = {
  choices?: Array<{
    delta?: {
      reasoning_content?: unknown;
      content?: unknown;
      tool_calls?: unknown;
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
  constructor(message: string, readonly status = 502) {
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
  return { authorization: `Bearer ${getApiKey()}`, "content-type": "application/json" };
}

function numberOrUndefined(candidate: unknown): number | undefined {
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

function usageFromChunk(value: DeepSeekChunk["usage"]): ChatUsage | null {
  if (!value || typeof value !== "object") return null;
  const usage: ChatUsage = {
    promptTokens: numberOrUndefined(value.prompt_tokens),
    completionTokens: numberOrUndefined(value.completion_tokens),
    totalTokens: numberOrUndefined(value.total_tokens),
    reasoningTokens: numberOrUndefined(value.completion_tokens_details?.reasoning_tokens),
  };
  return Object.values(usage).some((item) => item !== undefined) ? usage : null;
}

type MutableToolCall = { id: string; name: string; arguments: string };

function flushToolCalls(toolCalls: Map<number, MutableToolCall>): ChatStreamEvent[] {
  const calls = [...toolCalls.entries()].sort(([left], [right]) => left - right);
  toolCalls.clear();
  return calls.map(([, call]) => {
    if (!call.id || !call.name || !call.arguments) {
      throw new DeepSeekError("DeepSeek returned an incomplete tool call.");
    }
    return {
      type: "tool_call" as const,
      call: { id: call.id, name: call.name, arguments: call.arguments } satisfies ChatToolCall,
    };
  });
}

function appendToolCallDeltas(target: Map<number, MutableToolCall>, value: unknown): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const delta = item as {
      index?: unknown;
      id?: unknown;
      function?: { name?: unknown; arguments?: unknown };
    };
    const index = typeof delta.index === "number" && Number.isInteger(delta.index) ? delta.index : target.size;
    const current = target.get(index) ?? { id: `tool_call_${index}`, name: "", arguments: "" };
    if (typeof delta.id === "string" && delta.id) current.id = delta.id;
    if (typeof delta.function?.name === "string") current.name += delta.function.name;
    if (typeof delta.function?.arguments === "string") current.arguments += delta.function.arguments;
    target.set(index, current);
  }
}

function parseChunk(data: string, toolCalls: Map<number, MutableToolCall>): ChatStreamEvent[] {
  if (data === "[DONE]") {
    return flushToolCalls(toolCalls);
  }

  let chunk: DeepSeekChunk;
  try {
    chunk = JSON.parse(data) as DeepSeekChunk;
  } catch {
    return [];
  }
  const delta = chunk.choices?.[0]?.delta;
  appendToolCallDeltas(toolCalls, delta?.tool_calls);
  const events: ChatStreamEvent[] = [];
  if (typeof delta?.reasoning_content === "string" && delta.reasoning_content) {
    events.push({ type: "reasoning", delta: delta.reasoning_content });
  }
  if (typeof delta?.content === "string" && delta.content) events.push({ type: "content", delta: delta.content });
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
  const toolCalls = new Map<number, MutableToolCall>();

  const consume = async function* (block: string): AsyncGenerator<ChatStreamEvent> {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data) return;
    for (const event of parseChunk(data, toolCalls)) {
      if (data === "[DONE]") completed = true;
      yield event;
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) yield* consume(block);
      if (done) break;
    }
    if (buffer.trim()) yield* consume(buffer);
    if (!completed && toolCalls.size) {
      for (const event of flushToolCalls(toolCalls)) yield event;
    }
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
  }
}

function baseMessages(request: ChatRequest): DeepSeekMessage[] {
  const history: DeepSeekMessage[] = [];
  for (const message of request.messages) {
    if (message.role === "assistant" && message.rounds?.length) {
      for (const round of message.rounds) {
        const calls = round.toolCalls ?? [];
        history.push({
          role: "assistant",
          content: round.content || null,
          ...(round.reasoning ? { reasoning_content: round.reasoning } : {}),
          ...(calls.length
            ? {
                tool_calls: calls.map((call) => ({
                  id: call.id,
                  type: "function" as const,
                  function: { name: call.name, arguments: call.arguments },
                })),
              }
            : {}),
        });
        for (const call of calls) {
          if (call.result) {
            history.push({
              role: "tool",
              content: JSON.stringify(call.result),
              tool_call_id: call.id,
              name: call.name,
            });
          }
        }
      }
      continue;
    }
    if (message.role === "assistant") {
      history.push({
        role: "assistant",
        content: message.content,
        ...(message.reasoning ? { reasoning_content: message.reasoning } : {}),
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: "function" as const,
                function: { name: call.name, arguments: call.arguments },
              })),
            }
          : {}),
      });
      continue;
    }
    history.push({ role: "user", content: message.content });
  }
  return [
    { role: "system", content: request.systemPrompt },
    ...(request.userPresence ? [{ role: "system" as const, content: request.userPresence }] : []),
    ...history,
  ];
}

/** Stream one provider round. Tool-call arguments are assembled before emission. */
export async function* streamDeepSeekChatRound(
  request: ChatRequest,
  options: DeepSeekRoundOptions = {},
  signal?: AbortSignal,
): AsyncGenerator<ChatStreamEvent> {
  const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: headers(),
    signal,
    body: JSON.stringify({
      model: request.model,
      messages: options.messages ?? baseMessages(request),
      stream: true,
      thinking: { type: request.thinking ? "enabled" : "disabled" },
      ...(request.thinking ? { reasoning_effort: request.reasoningEffort } : {}),
      ...(options.tools?.length ? { tools: options.tools, tool_choice: "auto" } : {}),
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

/** Backwards-compatible single-round stream used by simple consumers. */
export async function* streamDeepSeekChat(request: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatStreamEvent> {
  yield* streamDeepSeekChatRound(request, {}, signal);
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
    cachedModels = { expiresAt: Date.now() + MODEL_CACHE_TTL_MS, models: models.length ? models : DEFAULT_CHAT_MODELS };
    return cachedModels.models;
  } catch {
    return DEFAULT_CHAT_MODELS;
  }
}
