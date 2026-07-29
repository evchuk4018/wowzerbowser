import "server-only";
import type { ChatMessageInput, ChatModelInfo, ChatRequest, ChatStreamEvent, ChatToolCall, ChatUsage } from "../../../lib/chat-protocol";
import type { ChatProviderAdapter, ChatProviderRoundOptions } from "../../server/chat/chat-provider-adapter";
import { OPENROUTER_API_KEY, OPENROUTER_BASE_URL, openRouterHeaders } from "./openrouter-config";
import { OpenRouterError } from "./openrouter-catalog-adapter";

type ProviderMessage = Record<string, unknown>;
type Chunk = { model?: unknown; choices?: Array<{ delta?: Record<string, unknown> }>; usage?: Record<string, unknown>; error?: { message?: unknown } };
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
function usage(value: Chunk["usage"]): ChatUsage | null {
  if (!value) return null;
  const result = { promptTokens: number(value.prompt_tokens), completionTokens: number(value.completion_tokens), totalTokens: number(value.total_tokens), cachedPromptTokens: number((value.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens), reasoningTokens: number((value.completion_tokens_details as Record<string, unknown> | undefined)?.reasoning_tokens) };
  return Object.values(result).some((item) => item !== undefined) ? result : null;
}
function appendInput(target: ProviderMessage[], message: ChatMessageInput) {
  if (message.role === "user") {
    target.push({ role: "user", content: message.content });
    return;
  }
  for (const round of message.rounds ?? []) {
    target.push({
      role: "assistant",
      content: round.content || null,
      ...(round.reasoning ? { reasoning: round.reasoning } : {}),
      ...(round.toolCalls?.length ? { tool_calls: round.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })) } : {}),
    });
    for (const call of round.toolCalls ?? []) if (call.result) target.push({ role: "tool", tool_call_id: call.id, name: call.name, content: JSON.stringify(call.result) });
  }
  if (message.content || !message.rounds?.length) target.push({ role: "assistant", content: message.content, ...(message.reasoning ? { reasoning: message.reasoning } : {}) });
}
export function buildOpenRouterMessages(request: ChatRequest, options: ChatProviderRoundOptions): ProviderMessage[] {
  const result: ProviderMessage[] = [
    { role: "system", content: [request.systemPrompt, request.userPresence, ...options.systemInstructions].filter(Boolean).join("\n\n") },
  ];
  request.messages.forEach((message) => appendInput(result, message));
  for (const round of options.replayRounds) {
    result.push({
      role: "assistant", content: round.content || null,
      ...(round.reasoningDetails ? { reasoning_details: round.reasoningDetails } : {}),
      ...(round.toolCalls?.length ? { tool_calls: round.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })) } : {}),
    });
    for (const call of round.toolCalls ?? []) if (call.result) result.push({ role: "tool", tool_call_id: call.id, name: call.name, content: JSON.stringify(call.result) });
  }
  return result;
}
type ToolDelta = { id: string; name: string; arguments: string };
export async function* streamOpenRouterChatRound(request: ChatRequest, metadata: ChatModelInfo, options: ChatProviderRoundOptions, signal: AbortSignal, fetchImpl: typeof fetch = fetch): AsyncGenerator<ChatStreamEvent> {
  if (!OPENROUTER_API_KEY) throw new OpenRouterError("OpenRouter is not configured.", 503);
  const reasoning = metadata.reasoningRequired || request.thinking
    ? { effort: request.reasoningEffort }
    : metadata.supportedEfforts.length ? { effort: "none" } : undefined;
  const response = await fetchImpl(`${OPENROUTER_BASE_URL}/chat/completions`, {
    method: "POST", headers: openRouterHeaders(), signal,
    body: JSON.stringify({
      model: request.model.model, messages: buildOpenRouterMessages(request, options), stream: true,
      ...(reasoning ? { reasoning } : {}),
      ...(options.tools?.length ? { tools: options.tools, ...(metadata.supportedParameters.includes("tool_choice") ? { tool_choice: "auto" } : {}) } : {}),
    }),
  });
  if (!response.ok || !response.body) {
    options.onResponse?.(false);
    const detail = await response.text().catch(() => "");
    throw new OpenRouterError(detail.slice(0, 240) || `OpenRouter request failed (${response.status}).`, response.status >= 500 ? 502 : response.status);
  }
  options.onResponse?.(true);
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
  const calls = new Map<number, ToolDelta>(); let reasoningDetails: unknown[] = [];
  const consume = function* (block: string): Generator<ChatStreamEvent> {
    const data = block.split(/\r?\n/).filter((item) => item.startsWith("data:")).map((item) => item.slice(5).trim()).join("\n");
    if (!data || data === "[DONE]") return;
    let chunk: Chunk; try { chunk = JSON.parse(data) as Chunk; } catch { return; }
    if (chunk.error) throw new OpenRouterError(typeof chunk.error.message === "string" ? chunk.error.message : "OpenRouter streaming error.");
    const delta = chunk.choices?.[0]?.delta;
    if (typeof delta?.content === "string" && delta.content) yield { type: "content", delta: delta.content };
    const reasoningText = delta?.reasoning ?? delta?.reasoning_content;
    if (typeof reasoningText === "string" && reasoningText) yield { type: "reasoning", delta: reasoningText };
    if (Array.isArray(delta?.reasoning_details)) reasoningDetails = reasoningDetails.concat(delta.reasoning_details);
    if (Array.isArray(delta?.tool_calls)) for (const raw of delta.tool_calls) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>; const index = typeof item.index === "number" ? item.index : calls.size;
      const fn = item.function && typeof item.function === "object" ? item.function as Record<string, unknown> : {};
      const current = calls.get(index) ?? { id: "", name: "", arguments: "" };
      if (typeof item.id === "string" && item.id) current.id = item.id;
      if (typeof fn.name === "string") current.name += fn.name;
      if (typeof fn.arguments === "string") current.arguments += fn.arguments;
      calls.set(index, current);
    }
    const measured = usage(chunk.usage);
    if (measured) yield { type: "done", usage: measured, provider: "openrouter", model: typeof chunk.model === "string" ? chunk.model : request.model.model, ...(typeof chunk.usage?.cost === "number" ? { exactCostUsd: chunk.usage.cost } : {}), pricing: metadata.pricing };
  };
  try {
    while (true) {
      const { done, value } = await reader.read(); buffer += decoder.decode(value, { stream: !done });
      const blocks = buffer.split(/\r?\n\r?\n/); buffer = blocks.pop() ?? "";
      for (const block of blocks) yield* consume(block);
      if (done) break;
    }
    if (buffer.trim()) yield* consume(buffer);
    for (const call of [...calls.values()]) {
      if (!call.id || !call.name) throw new OpenRouterError("OpenRouter returned an incomplete tool call.");
      yield { type: "tool_call", call: call satisfies ChatToolCall };
    }
    if (reasoningDetails.length) yield { type: "reasoning_details", details: reasoningDetails };
  } finally {
    if (signal.aborted) await reader.cancel().catch(() => undefined);
  }
}
export const openRouterChatProviderAdapter: ChatProviderAdapter = {
  provider: "openrouter",
  assertConfigured() { if (!OPENROUTER_API_KEY) throw new OpenRouterError("OpenRouter is not configured.", 503); },
  streamRound: streamOpenRouterChatRound,
};
