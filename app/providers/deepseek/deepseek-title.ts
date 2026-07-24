import "server-only";

import { DEEPSEEK_BASE_URL, deepSeekHeaders } from "./deepseek-client-config";
import { DeepSeekError } from "./deepseek-error";

const TITLE_MODEL = "deepseek-v4-flash";

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

export async function generateDeepSeekTitle(firstTurn: string): Promise<string> {
  const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: deepSeekHeaders(),
    body: JSON.stringify({
      model: TITLE_MODEL,
      messages: [{
        role: "system",
        content: "Name this chat from the user's first turn. Return only a concise title of 2 to 5 words, with no quotation marks or punctuation.",
      }, { role: "user", content: firstTurn }],
      thinking: { type: "disabled" },
      stream: false,
      max_tokens: 24,
    }),
  });
  if (!response.ok) throw new DeepSeekError("DeepSeek could not name the chat.", response.status >= 500 ? 502 : response.status);
  const body = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new DeepSeekError("DeepSeek returned an invalid chat title.");
  return cleanTitle(content);
}
