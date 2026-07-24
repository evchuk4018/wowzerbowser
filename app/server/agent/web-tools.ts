import "server-only";

import type { ChatToolCall, ChatToolResult } from "../../../lib/chat-protocol";
import { configuredKeys, WebProviderError, withProviderKeys } from "./web-api-key-pool";

export const WEB_SEARCH_TOOL_NAME = "web_search";
export const FETCH_PAGE_TOOL_NAME = "fetch_page";
const TIMEOUT_MS = 12_000;
const MAX_RESULTS = 5;
const MAX_SNIPPET = 1_200;
const MAX_MARKDOWN = 24_000;

export const WEB_TOOL_DEFINITIONS = [
  { type: "function" as const, function: { name: WEB_SEARCH_TOOL_NAME, description: "Search the web for concise, current result snippets.", parameters: { type: "object", additionalProperties: false, required: ["query"], properties: { query: { type: "string", minLength: 1, maxLength: 400 }, count: { type: "integer", minimum: 1, maximum: MAX_RESULTS } } } } },
  { type: "function" as const, function: { name: FETCH_PAGE_TOOL_NAME, description: "Read a specific public web page as bounded Markdown.", parameters: { type: "object", additionalProperties: false, required: ["url"], properties: { url: { type: "string", minLength: 1, maxLength: 2_000, format: "uri" } } } } },
] as const;

export function availableWebTools() { return WEB_TOOL_DEFINITIONS.filter((tool) => configuredKeys(tool.function.name === WEB_SEARCH_TOOL_NAME ? "brave" : "exa").length); }
function parse(call: ChatToolCall): Record<string, unknown> { try { const value = JSON.parse(call.arguments); if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>; } catch {} throw new Error("The model returned invalid web tool arguments."); }
function text(value: unknown, max: number) { return typeof value === "string" ? value.trim().slice(0, max) : ""; }
async function providerFetch(url: string, init: RequestInit) { return fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) }); }

export async function executeWebTool(call: ChatToolCall): Promise<ChatToolResult> {
  const startedAt = Date.now();
  try {
    const input = parse(call);
    if (call.name === WEB_SEARCH_TOOL_NAME) {
      const query = text(input.query, 400); const count = Math.max(1, Math.min(MAX_RESULTS, Number(input.count) || MAX_RESULTS));
      if (!query) throw new Error("web_search requires a query.");
      const response = await withProviderKeys(configuredKeys("brave"), (key) => providerFetch(`https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q: query, count: String(count), text_decorations: "false" })}`, { headers: { Accept: "application/json", "X-Subscription-Token": key } }));
      if (!response.ok) throw response;
      const body = await response.json() as { web?: { results?: Array<{ title?: unknown; url?: unknown; description?: unknown }> } };
      const results = (body.web?.results ?? []).slice(0, count).map((item) => ({ title: text(item.title, 300), url: text(item.url, 2_000), snippet: text(item.description, MAX_SNIPPET) })).filter((item) => item.url);
      return { id: call.id, name: call.name, ok: true, stdout: "", stderr: "", durationMs: Date.now() - startedAt, web: { kind: "search", query, results } };
    }
    if (call.name === FETCH_PAGE_TOOL_NAME) {
      const url = text(input.url, 2_000); if (!/^https?:\/\//i.test(url)) throw new Error("fetch_page requires an http(s) URL.");
      const response = await withProviderKeys(configuredKeys("exa"), (key) => providerFetch("https://api.exa.ai/contents", { method: "POST", headers: { "content-type": "application/json", "x-api-key": key }, body: JSON.stringify({ urls: [url], text: { maxCharacters: MAX_MARKDOWN } }) }));
      if (!response.ok) throw response;
      const body = await response.json() as { results?: Array<{ text?: unknown }> };
      return { id: call.id, name: call.name, ok: true, stdout: "", stderr: "", durationMs: Date.now() - startedAt, web: { kind: "page", url, markdown: text(body.results?.[0]?.text, MAX_MARKDOWN) } };
    }
    throw new Error(`Unknown tool: ${call.name}`);
  } catch (error) {
    const message = error instanceof WebProviderError ? error.message : error instanceof Error ? error.message : "Web tool failed.";
    return { id: call.id, name: call.name, ok: false, stdout: "", stderr: message, durationMs: Date.now() - startedAt };
  }
}
