import "server-only";
import { deepSeekChatProviderAdapter } from "../../providers/deepseek/deepseek-chat-provider-adapter";
import { openRouterChatProviderAdapter } from "../../providers/openrouter/openrouter-chat-adapter";
import { chatProviderAdapter, registerChatProviderAdapter } from "./chat-provider-adapter";
registerChatProviderAdapter(deepSeekChatProviderAdapter);
registerChatProviderAdapter(openRouterChatProviderAdapter);
export { chatProviderAdapter };
