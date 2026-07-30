import "server-only";

import type { ChatToolCall, ChatToolResult } from "../../../lib/chat-protocol";
import { SEARCH_CURRENT_CHAT_TOOL_NAME } from "./current-chat-context-tool-manifest";

export type CurrentChatSearchEntry = {
  id: string;
  position: number;
  user: string;
  assistant: string;
  toolFacts: string[];
};

const MAX_RESULT_CHARACTERS = 16_000;

function redactSecrets(value: string): string {
  return value
    .replace(/\b(authorization|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|secret)\s*[:=]\s*(?:bearer\s+)?\S+/giu, "$1=[redacted]")
    .replace(/\bbearer\s+[A-Za-z0-9._~+/-]{12,}/giu, "Bearer [redacted]");
}

function terms(value: string): string[] {
  return [...new Set(value.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])];
}

function score(entry: CurrentChatSearchEntry, query: string, queryTerms: readonly string[]): number {
  const haystack = `${entry.user}\n${entry.assistant}\n${entry.toolFacts.join("\n")}`.toLocaleLowerCase();
  let value = haystack.includes(query.toLocaleLowerCase()) ? 20 : 0;
  for (const term of queryTerms) if (haystack.includes(term)) value += 2;
  return value > 0 ? value + Math.min(2, entry.position / 1_000) : 0;
}

function argumentsFor(call: ChatToolCall): { query: string; limit: number } {
  let value: unknown;
  try { value = JSON.parse(call.arguments); } catch { throw new Error("Invalid search_current_chat arguments."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid search_current_chat arguments.");
  const input = value as Record<string, unknown>;
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (!query || query.length > 400) throw new Error("query must contain 1 to 400 characters.");
  const limit = input.limit === undefined ? 5 : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error("limit must be an integer from 1 to 10.");
  return { query, limit };
}

export function executeCurrentChatContextTool(
  call: ChatToolCall,
  entries: readonly CurrentChatSearchEntry[],
): ChatToolResult {
  try {
    if (call.name !== SEARCH_CURRENT_CHAT_TOOL_NAME) throw new Error(`Unknown context tool: ${call.name}`);
    const { query, limit } = argumentsFor(call);
    const queryTerms = terms(query);
    const matches = entries
      .map((entry) => ({ entry, score: score(entry, query, queryTerms) }))
      .filter(({ score: relevance }) => relevance > 0)
      .sort((left, right) => right.score - left.score || right.entry.position - left.entry.position)
      .slice(0, limit);
    let remaining = MAX_RESULT_CHARACTERS;
    const results: unknown[] = [];
    for (const { entry } of matches) {
      if (remaining <= 0) break;
      const serialized = JSON.stringify({
        turnId: entry.id,
        position: entry.position,
        user: redactSecrets(entry.user),
        assistant: redactSecrets(entry.assistant),
        toolFacts: entry.toolFacts.map(redactSecrets),
      });
      const clipped = serialized.slice(0, remaining);
      remaining = Math.max(0, remaining - clipped.length);
      results.push(clipped === serialized ? JSON.parse(serialized) : { turnId: entry.id, position: entry.position, excerpt: clipped });
    }
    return {
      id: call.id,
      name: call.name,
      ok: true,
      stdout: JSON.stringify({ query, results }),
      stderr: "",
    };
  } catch (error) {
    return {
      id: call.id,
      name: call.name,
      ok: false,
      stdout: "",
      stderr: error instanceof Error ? error.message : "Current chat search failed.",
    };
  }
}
