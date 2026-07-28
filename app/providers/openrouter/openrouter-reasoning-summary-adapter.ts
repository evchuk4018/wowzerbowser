import "server-only";

import type { ChatUsage } from "../../../lib/chat-protocol";

const BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_REASONING_SUMMARY_MODEL = "openrouter/free";

export class OpenRouterReasoningSummaryError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "OpenRouterReasoningSummaryError";
  }
}

export type ReasoningSummaryAnswer = {
  summary: string;
  provider: "openrouter" | "deepseek";
  model: string;
  usage: ChatUsage | null;
};

function usageOf(value: Record<string, unknown> | null | undefined): ChatUsage | null {
  if (!value) return null;
  const number = (candidate: unknown) => typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
  const usage = {
    promptTokens: number(value.prompt_tokens),
    completionTokens: number(value.completion_tokens),
    totalTokens: number(value.total_tokens),
  };
  return Object.values(usage).some((item) => item !== undefined) ? usage : null;
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value.map((part) =>
    part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : "",
  ).join("").trim();
}

export async function summarizeReasoningWithOpenRouter(
  prompt: string,
  signal?: AbortSignal,
): Promise<ReasoningSummaryAnswer> {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) throw new OpenRouterReasoningSummaryError("OpenRouter is not configured.", 503);
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    signal,
    body: JSON.stringify({
      model: OPENROUTER_REASONING_SUMMARY_MODEL,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 32,
    }),
  });
  if (!response.ok) {
    await response.text().catch(() => "");
    throw new OpenRouterReasoningSummaryError(`Reasoning title request failed (${response.status}).`, response.status);
  }
  const payload = await response.json() as {
    model?: unknown;
    choices?: Array<{ message?: { content?: unknown } }>;
    usage?: Record<string, unknown> | null;
  };
  const summary = textOf(payload.choices?.[0]?.message?.content);
  if (!summary) throw new OpenRouterReasoningSummaryError("Reasoning title was empty.", 502);
  return {
    summary,
    provider: "openrouter",
    model: typeof payload.model === "string" && payload.model ? payload.model : OPENROUTER_REASONING_SUMMARY_MODEL,
    usage: usageOf(payload.usage),
  };
}
