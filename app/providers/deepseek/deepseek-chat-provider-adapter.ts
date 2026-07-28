import "server-only";
import type { ChatProviderAdapter } from "../../server/chat/chat-provider-adapter";
import { assertDeepSeekConfigured, streamDeepSeekChatRound } from "./deepseek-adapter";
export const deepSeekChatProviderAdapter: ChatProviderAdapter = {
  provider: "deepseek",
  assertConfigured: assertDeepSeekConfigured,
  streamRound(request, _metadata, options, signal) {
    return streamDeepSeekChatRound(request, options, signal);
  },
};
