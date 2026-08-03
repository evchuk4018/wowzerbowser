import "server-only";

import type { ChatModelInfo, ChatProvider, ChatRequest, ChatStreamEvent } from "../../../lib/chat-protocol";
import type { ChatProviderAdapter, ChatProviderRoundOptions } from "../../server/chat/chat-provider-adapter";

export function deterministicProviderEnabled(): boolean {
  return process.env.SMOKE_TEST_DETERMINISTIC_PROVIDER === "1";
}

export function deterministicChatModelInfo(ref: { provider: ChatProvider; model: string }): ChatModelInfo {
  return {
    ref,
    displayName: "Deterministic smoke model",
    description: "Only available to the disposable clean-install smoke test.",
    author: "Wowzer Bowser",
    architecture: "deterministic",
    inputModalities: ["text"],
    outputModalities: ["text"],
    toolSupport: false,
    supportedParameters: [],
    reasoningRequired: false,
    supportedEfforts: [],
    defaultReasoningEffort: null,
    contextLength: 32_000,
    createdAt: null,
    pricing: { inputUsdPerMillion: 0, cachedInputUsdPerMillion: 0, outputUsdPerMillion: 0, requestUsd: 0, reasoningUsdPerMillion: 0 },
  };
}

function responseFor(request: ChatRequest): string {
  if (/recurring automation/i.test(request.systemPrompt)) {
    return JSON.stringify({ matched: true, title: "Deterministic smoke automation", message: "Deterministic automation completed." });
  }
  return process.env.SMOKE_TEST_RESPONSE?.trim() || "Deterministic clean-install response.";
}

function adapter(provider: ChatProvider): ChatProviderAdapter {
  return {
    provider,
    assertConfigured() {},
    async *streamRound(request: ChatRequest, metadata: ChatModelInfo, _options: ChatProviderRoundOptions, signal: AbortSignal): AsyncGenerator<ChatStreamEvent> {
      if (signal.aborted) return;
      yield { type: "content", delta: responseFor(request) };
      if (signal.aborted) return;
      yield {
        type: "done",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        provider,
        model: metadata.ref.model,
        pricing: metadata.pricing,
      };
    },
  };
}

export const deterministicDeepSeekChatProviderAdapter = adapter("deepseek");
export const deterministicOpenRouterChatProviderAdapter = adapter("openrouter");
