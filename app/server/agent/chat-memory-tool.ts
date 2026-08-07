import "server-only";

import type { ChatToolCall, ChatToolResult, ChatUsage } from "../../../lib/chat-protocol";
import type { ChatConversation, ChatHistoryMessage } from "../../../lib/chat-history";
import { getActiveConversationTurns } from "../../../lib/chat-history";
import { searchChatConversations, getChatConversation } from "../chat/chat-history-store";
import { recallChatWithQwen } from "../../providers/openrouter/openrouter-qwen-text-adapter";
import { buildChatMemoryToolDefinitions, RECALL_CHATS_TOOL_NAME, SEARCH_CHATS_TOOL_NAME } from "./chat-memory-tool-manifest";
import { runtimeConfigSnapshot } from "../config/runtime-config-service";

const MAX_SAFE_QUERY = 200;
const MAX_SAFE_PROMPT = 20_000;
const MAX_SAFE_CONTEXT = 300_000;
export const availableChatMemoryTools = (openRouterConfigured = Boolean(process.env.OPENROUTER_API_KEY?.trim())) =>
  buildChatMemoryToolDefinitions().filter((tool) => tool.function.name !== RECALL_CHATS_TOOL_NAME || openRouterConfigured);

const failure = (call: ChatToolCall, message: string): ChatToolResult => ({ id: call.id, name: call.name, ok: false, stdout: "", stderr: message });
function args(call: ChatToolCall): Record<string, unknown> { try { const value = JSON.parse(call.arguments); if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>; } catch {} throw new Error("Invalid chat tool arguments."); }

function activeMessages(conversation: ChatConversation): ChatHistoryMessage[] {
  return getActiveConversationTurns(conversation).flatMap((turn) => {
    const version = turn.versions[turn.activeVersion];
    return version ? [version.user, version.assistant] : [];
  });
}

function buildContext(conversation: ChatConversation): string {
  const maxContext = Math.min(runtimeConfigSnapshot().chatMemoryContextMaxCharacters, MAX_SAFE_CONTEXT);
  const raw = activeMessages(conversation).map((message) => {
    const activities = message.activities?.length ? `\nActivities: ${JSON.stringify(message.activities)}` : "";
    return `[${message.role}]\n${message.content}${activities}`;
  }).join("\n\n");
  if (raw.length <= maxContext) return raw || "(empty conversation)";
  const head = Math.floor(maxContext * 0.2);
  return `${raw.slice(0, head)}\n\n[conversation clipped; only the most recent context is included]\n\n${raw.slice(-(maxContext - head - 80))}`;
}

export type ChatMemoryToolContext = { ownerId: string; signal: AbortSignal; contextCache: Map<string, string>; onRecallUsage?: (usage: { model: string; usage: ChatUsage; source: "exact" | "estimated"; exactCostUsd?: number }) => Promise<void> };

export function chatMemoryToolDefinitions(openRouterConfigured?: boolean) { return availableChatMemoryTools(openRouterConfigured); }

export async function executeChatMemoryTool(call: ChatToolCall, context: ChatMemoryToolContext): Promise<ChatToolResult> {
  try {
    const input = args(call);
    if (call.name === SEARCH_CHATS_TOOL_NAME) {
      const query = typeof input.query === "string" ? input.query.trim() : "";
      if (query.length > MAX_SAFE_QUERY) return failure(call, "Chat search query is too long.");
      const conversations = await searchChatConversations(context.ownerId, query);
      return { id: call.id, name: call.name, ok: true, stdout: JSON.stringify({ conversations }), stderr: "" };
    }
    if (call.name !== RECALL_CHATS_TOOL_NAME) return failure(call, `Unknown chat tool: ${call.name}`);
    const conversationId = typeof input.conversationId === "string" ? input.conversationId.trim() : "";
    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
    if (!conversationId || conversationId.length > 200) return failure(call, "conversationId is required and must be valid.");
    const configuration = runtimeConfigSnapshot();
    const maxPrompt = Math.min(configuration.chatMemoryRecallMaxPromptCharacters, MAX_SAFE_PROMPT);
    if (!prompt || prompt.length > maxPrompt) return failure(call, `prompt is required and must be at most ${maxPrompt.toLocaleString()} characters.`);
    let serialized = context.contextCache.get(conversationId);
    if (!serialized) {
      const conversation = await getChatConversation(context.ownerId, conversationId);
      if (!conversation) return failure(call, "That conversation was not found.");
      serialized = buildContext(conversation);
      context.contextCache.set(conversationId, serialized);
    }
    const answer = await recallChatWithQwen(serialized, prompt, {
      signal: context.signal,
      timeoutMs: Math.min(configuration.chatMemoryRecallTimeoutMs, 120_000),
      maxTokens: Math.min(configuration.chatMemoryRecallMaxOutputTokens, 8_000),
    });
    await context.onRecallUsage?.({ model: answer.model, usage: answer.usage ?? answer.estimatedUsage, source: answer.usage || answer.exactCostUsd !== undefined ? "exact" : "estimated", exactCostUsd: answer.exactCostUsd });
    return { id: call.id, name: call.name, ok: true, stdout: answer.answer, stderr: "" };
  } catch (error) {
    return failure(call, error instanceof Error ? error.message : "Chat memory tool failed.");
  }
}
