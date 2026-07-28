import "server-only";

import type {
  ChatModelInfo,
  ChatRequest,
  ChatStreamEvent,
  ChatToolCall,
  ChatUsage,
} from "../../../lib/chat-protocol";
import { DEFAULT_CHAT_MODELS } from "../../../lib/chat-protocol";
import {
  buildDeepSeekMessages,
  type DeepSeekMessage,
  type DeepSeekMessageBuildOptions,
} from "./deepseek-messages";
import { DeepSeekDsmlParser } from "./deepseek-dsml";
import { assertDeepSeekConfigured, DEEPSEEK_BASE_URL, deepSeekHeaders } from "./deepseek-client-config";
import { DeepSeekError } from "./deepseek-error";

export { buildDeepSeekMessages } from "./deepseek-messages";
export type { DeepSeekMessage } from "./deepseek-messages";

const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

export type DeepSeekToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type DeepSeekRoundOptions = {
  /**
   * Kept for simple consumers that already provide provider messages. The
   * chat orchestration path uses replayRounds so provider wire assembly stays
   * inside this adapter.
   */
  messages?: DeepSeekMessage[];
  replayRounds?: DeepSeekMessageBuildOptions["replayRounds"];
  systemInstructions?: DeepSeekMessageBuildOptions["systemInstructions"];
  tools?: readonly DeepSeekToolDefinition[];
  /** Reports whether the provider accepted the request before body parsing. */
  onResponse?: (accepted: boolean) => void;
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
    prompt_tokens_details?: { cached_tokens?: unknown };
    completion_tokens_details?: { reasoning_tokens?: unknown };
  } | null;
};

export { DeepSeekError, assertDeepSeekConfigured };

let cachedModels: { expiresAt: number; models: ChatModelInfo[] } | null = null;

function numberOrUndefined(candidate: unknown): number | undefined {
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

function usageFromChunk(value: DeepSeekChunk["usage"]): ChatUsage | null {
  if (!value || typeof value !== "object") return null;
  const usage: ChatUsage = {
    promptTokens: numberOrUndefined(value.prompt_tokens),
    completionTokens: numberOrUndefined(value.completion_tokens),
    totalTokens: numberOrUndefined(value.total_tokens),
    cachedPromptTokens: numberOrUndefined(value.prompt_tokens_details?.cached_tokens),
    reasoningTokens: numberOrUndefined(value.completion_tokens_details?.reasoning_tokens),
  };
  return Object.values(usage).some((item) => item !== undefined) ? usage : null;
}

type MutableToolCall = { id: string; name: string; arguments: string };

type StreamParseState = {
  toolCalls: Map<number, MutableToolCall>;
  contentDsmlParser: DeepSeekDsmlParser;
  reasoningDsmlParser: DeepSeekDsmlParser;
  dsmlEnabled: boolean;
  dsmlCalls: ChatToolCall[];
  finalized: boolean;
};

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

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalizeJson(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalizeJson(item)]),
  );
}

function canonicalArguments(value: string): string {
  try {
    return JSON.stringify(canonicalizeJson(JSON.parse(value)));
  } catch {
    return value.trim();
  }
}

function isSameToolCall(left: ChatToolCall, right: ChatToolCall): boolean {
  return left.name === right.name && canonicalArguments(left.arguments) === canonicalArguments(right.arguments);
}

function throwMalformedDsml(): never {
  throw new DeepSeekError("DeepSeek returned malformed or truncated DSML tool-call markup.");
}

function finishStream(state: StreamParseState): ChatStreamEvent[] {
  if (state.finalized) return [];
  state.finalized = true;

  const events: ChatStreamEvent[] = [];
  if (state.dsmlEnabled) {
    const reasoningTail = state.reasoningDsmlParser.finish();
    const contentTail = state.contentDsmlParser.finish();
    if (reasoningTail.rejected || contentTail.rejected) throwMalformedDsml();
    if (reasoningTail.content) events.push({ type: "reasoning", delta: reasoningTail.content });
    if (contentTail.content) events.push({ type: "content", delta: contentTail.content });
    state.dsmlCalls.push(...reasoningTail.toolCalls, ...contentTail.toolCalls);
  }

  const nativeEvents = flushToolCalls(state.toolCalls);
  events.push(...nativeEvents);
  const nativeCalls = nativeEvents
    .filter((event): event is Extract<ChatStreamEvent, { type: "tool_call" }> => event.type === "tool_call")
    .map((event) => event.call);
  const matchedNative = new Set<number>();
  for (const call of state.dsmlCalls) {
    const duplicateIndex = nativeCalls.findIndex(
      (nativeCall, index) => !matchedNative.has(index) && isSameToolCall(nativeCall, call),
    );
    if (duplicateIndex >= 0) {
      matchedNative.add(duplicateIndex);
      continue;
    }
    events.push({ type: "tool_call", call });
  }
  return events;
}

function parseChunk(data: string, state: StreamParseState): ChatStreamEvent[] {
  if (data === "[DONE]") {
    return finishStream(state);
  }

  let chunk: DeepSeekChunk;
  try {
    chunk = JSON.parse(data) as DeepSeekChunk;
  } catch {
    return [];
  }
  const delta = chunk.choices?.[0]?.delta;
  appendToolCallDeltas(state.toolCalls, delta?.tool_calls);
  const events: ChatStreamEvent[] = [];
  if (typeof delta?.reasoning_content === "string" && delta.reasoning_content) {
    if (!state.dsmlEnabled) {
      events.push({ type: "reasoning", delta: delta.reasoning_content });
    } else {
      const parsed = state.reasoningDsmlParser.feed(delta.reasoning_content);
      if (parsed.rejected) throwMalformedDsml();
      if (parsed.content) events.push({ type: "reasoning", delta: parsed.content });
      if (parsed.toolCalls.length) state.dsmlCalls.push(...parsed.toolCalls);
    }
  }
  if (typeof delta?.content === "string" && delta.content) {
    if (!state.dsmlEnabled) {
      events.push({ type: "content", delta: delta.content });
    } else {
      const parsed = state.contentDsmlParser.feed(delta.content);
      if (parsed.rejected) throwMalformedDsml();
      if (parsed.content) events.push({ type: "content", delta: parsed.content });
      if (parsed.toolCalls.length) state.dsmlCalls.push(...parsed.toolCalls);
    }
  }
  const usage = usageFromChunk(chunk.usage);
  if (usage) events.push({ type: "done", usage });
  return events;
}

async function* parseSse(response: Response, dsmlEnabled: boolean): AsyncGenerator<ChatStreamEvent> {
  if (!response.body) throw new DeepSeekError("DeepSeek returned an empty stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  const state: StreamParseState = {
    toolCalls: new Map<number, MutableToolCall>(),
    contentDsmlParser: new DeepSeekDsmlParser(),
    reasoningDsmlParser: new DeepSeekDsmlParser(),
    dsmlEnabled,
    dsmlCalls: [],
    finalized: false,
  };

  const consume = async function* (block: string): AsyncGenerator<ChatStreamEvent> {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data) return;
    if (data === "[DONE]") completed = true;
    for (const event of parseChunk(data, state)) {
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
    if (!completed) {
      for (const event of finishStream(state)) yield event;
    }
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
  }
}

/** Stream one provider round. Tool-call arguments are assembled before emission. */
export async function* streamDeepSeekChatRound(
  request: ChatRequest,
  options: DeepSeekRoundOptions = {},
  signal?: AbortSignal,
): AsyncGenerator<ChatStreamEvent> {
  const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: deepSeekHeaders(),
    signal,
    body: JSON.stringify({
      model: typeof request.model === "string" ? request.model : request.model.model,
      messages: options.messages ?? buildDeepSeekMessages(request, options),
      stream: true,
      thinking: { type: request.thinking ? "enabled" : "disabled" },
      ...(request.thinking ? { reasoning_effort: request.reasoningEffort } : {}),
      ...(options.tools?.length ? { tools: options.tools, tool_choice: "auto" } : {}),
    }),
  });
  if (!response.ok) {
    options.onResponse?.(false);
    const providerMessage = await response.text().catch(() => "");
    throw new DeepSeekError(
      providerMessage.slice(0, 240) || `DeepSeek request failed (${response.status}).`,
      response.status >= 400 && response.status < 500 ? response.status : 502,
    );
  }
  options.onResponse?.(true);
  yield* parseSse(response, Boolean(options.tools?.length));
}

/** Backwards-compatible single-round stream used by simple consumers. */
export async function* streamDeepSeekChat(request: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatStreamEvent> {
  yield* streamDeepSeekChatRound(request, {}, signal);
}

export async function listDeepSeekModels(): Promise<ChatModelInfo[]> {
  if (cachedModels && cachedModels.expiresAt > Date.now()) return cachedModels.models;
  try {
    const response = await fetch(`${DEEPSEEK_BASE_URL}/models`, { headers: deepSeekHeaders() });
    if (!response.ok) throw new Error("Model discovery failed.");
    const body = (await response.json()) as DeepSeekModelResponse;
    const availableIds = new Set(
      (body.data ?? []).filter((item) => typeof item.id === "string").map((item) => item.id),
    );
    const models = DEFAULT_CHAT_MODELS.filter((model) => availableIds.has(model.ref.model));
    cachedModels = { expiresAt: Date.now() + MODEL_CACHE_TTL_MS, models: models.length ? models : DEFAULT_CHAT_MODELS };
    return cachedModels.models;
  } catch {
    return DEFAULT_CHAT_MODELS;
  }
}
