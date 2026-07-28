import "server-only";

import type { ChatUsage } from "../../../lib/chat-protocol";
import { DEEPSEEK_BASE_URL, deepSeekHeaders } from "./deepseek-client-config";
import { DeepSeekError } from "./deepseek-error";
export type ReasoningSummaryAnswer = {
  summary: string;
  provider: "deepseek";
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

export async function summarizeReasoningWithDeepSeekFlash(
  prompt: string,
  signal?: AbortSignal,
): Promise<ReasoningSummaryAnswer> {
  const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: deepSeekHeaders(),
    signal,
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: prompt }],
      thinking: { type: "disabled" },
      max_tokens: 32,
    }),
  });
  if (!response.ok) {
    await response.text().catch(() => "");
    throw new DeepSeekError(`Reasoning title fallback failed (${response.status}).`, response.status);
  }
  const payload = await response.json() as {
    choices?: Array<{ message?: { content?: unknown } }>;
    usage?: Record<string, unknown> | null;
  };
  const summary = typeof payload.choices?.[0]?.message?.content === "string"
    ? payload.choices[0].message.content.trim()
    : "";
  if (!summary) throw new DeepSeekError("Reasoning title fallback was empty.", 502);
  return { summary, provider: "deepseek", model: "deepseek-v4-flash", usage: usageOf(payload.usage) };
}
