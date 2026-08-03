import "server-only";
import { deepSeekChatProviderAdapter } from "../../providers/deepseek/deepseek-chat-provider-adapter";
import { openRouterChatProviderAdapter } from "../../providers/openrouter/openrouter-chat-adapter";
import {
  deterministicDeepSeekChatProviderAdapter,
  deterministicOpenRouterChatProviderAdapter,
  deterministicProviderEnabled,
} from "../../providers/deterministic/deterministic-chat-adapter";
import { chatProviderAdapter, registerChatProviderAdapter } from "./chat-provider-adapter";
registerChatProviderAdapter(deterministicProviderEnabled() ? deterministicDeepSeekChatProviderAdapter : deepSeekChatProviderAdapter);
registerChatProviderAdapter(deterministicProviderEnabled() ? deterministicOpenRouterChatProviderAdapter : openRouterChatProviderAdapter);
export { chatProviderAdapter };
