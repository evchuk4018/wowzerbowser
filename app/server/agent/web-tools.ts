import "server-only";

import type { ChatToolCall, ChatToolResult } from "../../../lib/chat-protocol";
import { configuredKeys, WebProviderError, withProviderKeys } from "./web-api-key-pool";

export const WEB_SEARCH_TOOL_NAME = "web_search";
export const FETCH_PAGE_TOOL_NAME = "fetch_page";
export const CHECK_TIME_TOOL_NAME = "check_time";
export const CHECK_DATE_TOOL_NAME = "check_date";
export const CHECK_LOCATION_TOOL_NAME = "check_location";
const TIMEOUT_MS = 12_000;
const MAX_RESULTS = 5;
const MAX_SNIPPET = 1_200;
const MAX_MARKDOWN = 24_000;
const MAX_TIME_ZONE = 100;
const MAX_LOCATION = 300;

export const WEB_TOOL_DEFINITIONS = [
  { type: "function" as const, function: { name: WEB_SEARCH_TOOL_NAME, description: "Search the web for concise, current result snippets.", parameters: { type: "object", additionalProperties: false, required: ["query"], properties: { query: { type: "string", minLength: 1, maxLength: 400 }, count: { type: "integer", minimum: 1, maximum: MAX_RESULTS } } } } },
  { type: "function" as const, function: { name: FETCH_PAGE_TOOL_NAME, description: "Read a specific public web page as bounded Markdown.", parameters: { type: "object", additionalProperties: false, required: ["url"], properties: { url: { type: "string", minLength: 1, maxLength: 2_000, format: "uri" } } } } },
  { type: "function" as const, function: { name: CHECK_TIME_TOOL_NAME, description: "Check the current server time, optionally in an IANA time zone.", parameters: { type: "object", additionalProperties: false, properties: { timeZone: { type: "string", minLength: 1, maxLength: MAX_TIME_ZONE } } } } },
  { type: "function" as const, function: { name: CHECK_DATE_TOOL_NAME, description: "Check the current server calendar date, optionally in an IANA time zone.", parameters: { type: "object", additionalProperties: false, properties: { timeZone: { type: "string", minLength: 1, maxLength: MAX_TIME_ZONE } } } } },
  { type: "function" as const, function: { name: CHECK_LOCATION_TOOL_NAME, description: "Check the configured coarse deployment location. This does not locate the user.", parameters: { type: "object", additionalProperties: false, properties: {} } } },
] as const;

function configuredLocation(): string | undefined {
  const location = process.env.DEPLOYMENT_LOCATION?.trim().slice(0, MAX_LOCATION);
  return location || undefined;
}

export function availableWebTools() {
  return WEB_TOOL_DEFINITIONS.filter((tool) => {
    switch (tool.function.name) {
      case WEB_SEARCH_TOOL_NAME: return configuredKeys("brave").length > 0;
      case FETCH_PAGE_TOOL_NAME: return configuredKeys("exa").length > 0;
      case CHECK_LOCATION_TOOL_NAME: return configuredLocation() !== undefined;
      default: return true;
    }
  });
}

function parse(call: ChatToolCall): Record<string, unknown> {
  try {
    const value = JSON.parse(call.arguments);
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {}
  throw new Error("The model returned invalid web tool arguments.");
}

function text(value: unknown, max: number) { return typeof value === "string" ? value.trim().slice(0, max) : ""; }
function searchQuery(input: Record<string, unknown>): string {
  // Some OpenAI-compatible providers occasionally emit the conventional `q`
  // spelling even when the advertised schema calls the field `query`. Accept
  // that wire-level alias so a valid search does not turn into a retry loop.
  return text(input.query ?? input.q, 400);
}
function requireOnly(input: Record<string, unknown>, allowed: readonly string[], tool: string) {
  const unexpected = Object.keys(input).find((key) => !allowed.includes(key));
  if (unexpected) throw new Error(`${tool} received an unexpected argument.`);
}
function optionalTimeZone(input: Record<string, unknown>, tool: string): string | undefined {
  requireOnly(input, ["timeZone"], tool);
  if (input.timeZone === undefined) return undefined;
  if (typeof input.timeZone !== "string" || !input.timeZone.trim() || input.timeZone.trim().length > MAX_TIME_ZONE) {
    throw new Error(`${tool} timeZone must be a non-empty IANA time zone string.`);
  }
  return input.timeZone.trim();
}
function dateTimeFormat(timeZone: string | undefined, options: Intl.DateTimeFormatOptions) {
  try { return new Intl.DateTimeFormat("en-CA", { ...options, ...(timeZone ? { timeZone } : {}) }); } catch { throw new Error("Invalid IANA time zone."); }
}
function dateParts(formatter: Intl.DateTimeFormat, now: Date) {
  const parts = formatter.formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  const year = get("year"); const month = get("month"); const day = get("day");
  if (!year || !month || !day) throw new Error("The server could not format the current date.");
  return { year, month, day, hour: get("hour"), minute: get("minute"), second: get("second") };
}
async function providerFetch(url: string, init: RequestInit) { return fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) }); }

export async function executeWebTool(call: ChatToolCall): Promise<ChatToolResult> {
  const startedAt = Date.now();
  try {
    const input = parse(call);
    if (call.name === CHECK_TIME_TOOL_NAME || call.name === CHECK_DATE_TOOL_NAME) {
      const timeZone = optionalTimeZone(input, call.name);
      const formatter = dateTimeFormat(timeZone, call.name === CHECK_TIME_TOOL_NAME
        ? { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }
        : { year: "numeric", month: "2-digit", day: "2-digit" });
      const parts = dateParts(formatter, new Date());
      const resolvedTimeZone = formatter.resolvedOptions().timeZone;
      const utility = call.name === CHECK_TIME_TOOL_NAME
        ? { kind: "time" as const, currentTime: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`, timeZone: resolvedTimeZone }
        : { kind: "date" as const, currentDate: `${parts.year}-${parts.month}-${parts.day}`, timeZone: resolvedTimeZone };
      return { id: call.id, name: call.name, ok: true, stdout: "", stderr: "", durationMs: Date.now() - startedAt, utility };
    }
    if (call.name === CHECK_LOCATION_TOOL_NAME) {
      requireOnly(input, [], call.name);
      const location = configuredLocation();
      const utility = location
        ? { kind: "location" as const, available: true as const, location, source: "deployment_metadata" as const }
        : { kind: "location" as const, available: false as const, message: "Deployment location is not configured." };
      return { id: call.id, name: call.name, ok: true, stdout: "", stderr: "", durationMs: Date.now() - startedAt, utility };
    }
    if (call.name === WEB_SEARCH_TOOL_NAME) {
      requireOnly(input, ["query", "q", "count"], call.name);
      const query = searchQuery(input); const count = Math.max(1, Math.min(MAX_RESULTS, Number(input.count) || MAX_RESULTS));
      if (!query) throw new Error("web_search requires a query.");
      const response = await withProviderKeys(configuredKeys("brave"), (key) => providerFetch(`https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q: query, count: String(count), text_decorations: "false" })}`, { headers: { Accept: "application/json", "X-Subscription-Token": key } }));
      if (!response.ok) throw response;
      const body = await response.json() as { web?: { results?: Array<{ title?: unknown; url?: unknown; description?: unknown }> } };
      const results = (body.web?.results ?? []).slice(0, count).map((item) => ({ title: text(item.title, 300), url: text(item.url, 2_000), snippet: text(item.description, MAX_SNIPPET) })).filter((item) => item.url);
      return { id: call.id, name: call.name, ok: true, stdout: "", stderr: "", durationMs: Date.now() - startedAt, web: { kind: "search", query, results } };
    }
    if (call.name === FETCH_PAGE_TOOL_NAME) {
      requireOnly(input, ["url"], call.name);
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
