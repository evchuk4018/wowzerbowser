import "server-only";

import type { ChatUsage } from "../../../lib/chat-protocol";
import { OPENROUTER_API_KEY, OPENROUTER_BASE_URL, OPENROUTER_DEEPSEEK_FLASH_MODEL, OPENROUTER_QWEN_FLASH_MODEL, openRouterHeaders } from "./openrouter-config";
import { OpenRouterError } from "./openrouter-catalog-adapter";

export const OPENROUTER_DREAMING_CONSOLIDATION_MODEL = OPENROUTER_QWEN_FLASH_MODEL;

type ResponsePayload = {
  model?: unknown;
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown; cost?: unknown };
};

const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

export async function consolidateDreamingMemoryWithQwen(
  prompt: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<{ summary: string; model: string; usage: ChatUsage | null; exactCostUsd?: number }> {
  if (!OPENROUTER_API_KEY) throw new OpenRouterError("OpenRouter dreaming consolidation is not configured.", 503);
  const signal = AbortSignal.timeout(options.timeoutMs ?? 30_000);
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: "POST", headers: openRouterHeaders(), signal,
      body: JSON.stringify({
        models: [OPENROUTER_DREAMING_CONSOLIDATION_MODEL, OPENROUTER_DEEPSEEK_FLASH_MODEL],
        messages: [{ role: "user", content: prompt }],
        reasoning: { enabled: true },
        max_tokens: 2_500,
      }),
    });
  } catch {
    throw new OpenRouterError("OpenRouter dreaming consolidation is unavailable.", 502);
  }
  if (!response.ok) throw new OpenRouterError("OpenRouter rejected dreaming consolidation.", response.status >= 500 ? 502 : response.status);
  let payload: ResponsePayload;
  try { payload = await response.json() as ResponsePayload; } catch { throw new OpenRouterError("OpenRouter returned invalid consolidation JSON.", 502); }
  const raw = payload.choices?.[0]?.message?.content;
  const summary = typeof raw === "string" ? raw.trim() : "";
  if (!summary) throw new OpenRouterError("OpenRouter returned an empty consolidation.", 502);
  const rawUsage = payload.usage;
  const usageValues = {
    promptTokens: number(rawUsage?.prompt_tokens),
    completionTokens: number(rawUsage?.completion_tokens),
    totalTokens: number(rawUsage?.total_tokens),
  };
  return {
    summary,
    model: typeof payload.model === "string" ? payload.model : OPENROUTER_DREAMING_CONSOLIDATION_MODEL,
    usage: Object.values(usageValues).some((value) => value !== undefined) ? usageValues : null,
    ...(number(rawUsage?.cost) === undefined ? {} : { exactCostUsd: number(rawUsage?.cost) }),
  };
}
