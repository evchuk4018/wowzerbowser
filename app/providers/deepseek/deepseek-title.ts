import "server-only";

import type { ChatUsage } from "../../../lib/chat-protocol";
import { estimateUsageFromText } from "../../../lib/usage-pricing";
import { DEEPSEEK_BASE_URL, deepSeekHeaders } from "./deepseek-client-config";
import { DeepSeekError } from "./deepseek-error";

const TITLE_MODEL = "deepseek-v4-flash";

export type DeepSeekTitleUsage = {
  usage: ChatUsage | null;
  estimatedUsage: ChatUsage;
};

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function cleanTitle(value: string): string {
  const words = value
    .replace(/[\r\n]+/g, " ")
    .replace(/^[\s"'`]+|[\s"'`.]+$/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5);
  if (words.length === 1) words.push("Discussion");
  return words.length >= 2 ? words.join(" ") : "New Conversation";
}

export async function generateDeepSeekTitle(
  firstTurn: string,
  persistUsage?: (usage: DeepSeekTitleUsage) => Promise<void>,
): Promise<string> {
  const payload = {
    model: TITLE_MODEL,
    messages: [{
      role: "system",
      content: "Name this chat from the user's first turn. Return only a concise title of 2 to 5 words, with no quotation marks or punctuation.",
    }, { role: "user", content: firstTurn }],
    thinking: { type: "disabled" },
    stream: false,
    max_tokens: 24,
  };
  let usage: ChatUsage | null = null;
  let content = "";
  let providerAccepted = false;
  try {
    const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: deepSeekHeaders(),
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new DeepSeekError("DeepSeek could not name the chat.", response.status >= 500 ? 502 : response.status);
    providerAccepted = true;
    const body = await response.json() as {
      choices?: Array<{ message?: { content?: unknown } }>;
      usage?: {
        prompt_tokens?: unknown;
        completion_tokens?: unknown;
        total_tokens?: unknown;
        prompt_tokens_details?: { cached_tokens?: unknown };
      } | null;
    };
    const parsedUsage = body.usage;
    if (parsedUsage) {
      const parsed: ChatUsage = {
        promptTokens: numberOrUndefined(parsedUsage.prompt_tokens),
        completionTokens: numberOrUndefined(parsedUsage.completion_tokens),
        totalTokens: numberOrUndefined(parsedUsage.total_tokens),
        cachedPromptTokens: numberOrUndefined(parsedUsage.prompt_tokens_details?.cached_tokens),
      };
      if (Object.values(parsed).some((value) => value !== undefined)) usage = parsed;
    }
    const rawContent = body.choices?.[0]?.message?.content;
    if (typeof rawContent !== "string") throw new DeepSeekError("DeepSeek returned an invalid chat title.");
    content = rawContent;
    return cleanTitle(rawContent);
  } finally {
    if (providerAccepted) {
      await persistUsage?.({
        usage,
        estimatedUsage: estimateUsageFromText(JSON.stringify(payload), content),
      });
    }
  }
}
