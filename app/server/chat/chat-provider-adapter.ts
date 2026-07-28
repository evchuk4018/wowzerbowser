import "server-only";
import type { ChatAssistantRound, ChatModelInfo, ChatProvider, ChatRequest, ChatStreamEvent } from "../../../lib/chat-protocol";
import type { DeepSeekToolDefinition } from "../../providers/deepseek/deepseek-adapter";

export type ChatProviderRoundOptions = {
  replayRounds: ChatAssistantRound[];
  systemInstructions: string[];
  tools?: readonly DeepSeekToolDefinition[];
  onResponse?: (accepted: boolean) => void;
};
export interface ChatProviderAdapter {
  readonly provider: ChatProvider;
  assertConfigured(): void;
  streamRound(request: ChatRequest, metadata: ChatModelInfo, options: ChatProviderRoundOptions, signal: AbortSignal): AsyncGenerator<ChatStreamEvent>;
}
const adapters = new Map<ChatProvider, ChatProviderAdapter>();
export function registerChatProviderAdapter(adapter: ChatProviderAdapter) { adapters.set(adapter.provider, adapter); }
export function chatProviderAdapter(provider: ChatProvider): ChatProviderAdapter {
  const adapter = adapters.get(provider);
  if (!adapter) throw new Error(`No chat provider adapter is registered for ${provider}.`);
  return adapter;
}
