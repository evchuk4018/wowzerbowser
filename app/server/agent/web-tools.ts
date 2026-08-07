import "server-only";

import type { ChatToolCall, ChatToolResult } from "../../../lib/chat-protocol";
import { CHAT_SOURCE_SNIPPET_MAX_LENGTH, sourceForUrl } from "../../../lib/chat-citations";
import { isSearchFocus, isSearchFreshness, type SearchFocus, type SearchFreshness } from "../../../lib/search-protocol";
import { SearchNoResultsError, SearchUnavailableError, searchSelfHosted } from "../search/search-service";
import { fetchResearchPage } from "../research/research-page-service";
import { runtimeConfigSnapshot } from "../config/runtime-config-service";

export const WEB_SEARCH_TOOL_NAME = "web_search";
export const FETCH_PAGE_TOOL_NAME = "fetch_page";
export const CHECK_TIME_TOOL_NAME = "check_time";
export const CHECK_DATE_TOOL_NAME = "check_date";
export const CHECK_LOCATION_TOOL_NAME = "check_location";
const MAX_RESULTS = 20;
const MAX_SNIPPET = CHAT_SOURCE_SNIPPET_MAX_LENGTH;
const MAX_MARKDOWN = 24_000;
const MAX_TIME_ZONE = 100;
const MAX_LOCATION = 300;
type WebSearchLimitKey =
  | "webSearchMaxResultsGeneral"
  | "webSearchMaxResultsNews"
  | "webSearchMaxResultsCommunity"
  | "webSearchMaxResultsReference";

function configuredLimit(key: WebSearchLimitKey | "webFetchMaxMarkdownCharacters", fallback: number, hardCap: number): number {
  const value = (runtimeConfigSnapshot() as unknown as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isSafeInteger(value)
    ? Math.max(1, Math.min(hardCap, value))
    : fallback;
}

function webSearchMaxResults(focus: SearchFocus): number {
  const key: WebSearchLimitKey = focus === "news"
    ? "webSearchMaxResultsNews"
    : focus === "community"
      ? "webSearchMaxResultsCommunity"
      : focus === "reference"
        ? "webSearchMaxResultsReference"
        : "webSearchMaxResultsGeneral";
  return configuredLimit(key, MAX_RESULTS, MAX_RESULTS);
}

function webSearchSchemaMaxResults(): number {
  return Math.max(
    webSearchMaxResults("general"),
    webSearchMaxResults("news"),
    webSearchMaxResults("community"),
    webSearchMaxResults("reference"),
  );
}

function webFetchMaxMarkdownCharacters(): number {
  return configuredLimit("webFetchMaxMarkdownCharacters", MAX_MARKDOWN, MAX_MARKDOWN);
}

function webToolDefinitions() {
  const searchMaximum = webSearchSchemaMaxResults();
  return [
    { type: "function" as const, function: { name: WEB_SEARCH_TOOL_NAME, description: "Search the web for concise, current result snippets. The active result limit is focus-specific and bounded for safety. The search may use a small number of intent-targeted queries when freshness, ambiguity, recommendations, or community evidence justify it.", parameters: { type: "object", additionalProperties: false, required: ["query"], properties: { query: { type: "string", minLength: 1, maxLength: 400 }, count: { type: "integer", minimum: 1, maximum: searchMaximum }, focus: { type: "string", enum: ["general", "news", "community", "reference"] }, freshness: { type: "string", enum: ["day", "week", "month", "year"] } } } } },
    { type: "function" as const, function: { name: FETCH_PAGE_TOOL_NAME, description: "Read a specific public web page as bounded Markdown. The active Markdown output limit is configurable within a hard safety cap. Use a URL returned by web_search or explicitly supplied by the user; do not guess undocumented paths.", parameters: { type: "object", additionalProperties: false, required: ["url"], properties: { url: { type: "string", minLength: 1, maxLength: 2_000, format: "uri" } } } } },
    { type: "function" as const, function: { name: CHECK_TIME_TOOL_NAME, description: "Check the current server time, optionally in an IANA time zone.", parameters: { type: "object", additionalProperties: false, properties: { timeZone: { type: "string", minLength: 1, maxLength: MAX_TIME_ZONE } } } } },
    { type: "function" as const, function: { name: CHECK_DATE_TOOL_NAME, description: "Check the current server calendar date, optionally in an IANA time zone.", parameters: { type: "object", additionalProperties: false, properties: { timeZone: { type: "string", minLength: 1, maxLength: MAX_TIME_ZONE } } } } },
    { type: "function" as const, function: { name: CHECK_LOCATION_TOOL_NAME, description: "Check the configured coarse deployment location. This does not locate the user.", parameters: { type: "object", additionalProperties: false, properties: {} } } },
  ] as const;
}

export const WEB_TOOL_DEFINITIONS = webToolDefinitions();

function configuredLocation(): string | undefined {
  const location = runtimeConfigSnapshot().deploymentLocation.trim().slice(0, MAX_LOCATION);
  return location || undefined;
}

export function availableWebTools() {
  const definitions = webToolDefinitions();
  return definitions.filter((tool) => {
    switch (tool.function.name) {
      case WEB_SEARCH_TOOL_NAME: return configuredSearchStack();
      case FETCH_PAGE_TOOL_NAME: return configuredSearchStack();
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
function searchFocus(input: Record<string, unknown>, tool: string): SearchFocus {
  if (input.focus === undefined) return "general";
  if (!isSearchFocus(input.focus)) throw new Error(`${tool} focus must be general, news, community, or reference.`);
  return input.focus;
}
function searchFreshness(input: Record<string, unknown>, tool: string): SearchFreshness | undefined {
  if (input.freshness === undefined) return undefined;
  if (!isSearchFreshness(input.freshness)) throw new Error(`${tool} freshness must be day, week, month, or year.`);
  return input.freshness;
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
function configuredSearchStack(): boolean {
  return runtimeConfigSnapshot().searchStackEnabled;
}

export async function executeWebTool(call: ChatToolCall, signal?: AbortSignal): Promise<ChatToolResult> {
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
      requireOnly(input, ["query", "q", "count", "focus", "freshness"], call.name);
      const query = searchQuery(input);
      const focus = searchFocus(input, call.name);
      const maxResults = webSearchMaxResults(focus);
      const count = Math.max(1, Math.min(maxResults, Number(input.count) || maxResults));
      if (!query) throw new Error("web_search requires a query.");
      const results = (await searchSelfHosted({ query, count, focus, freshness: searchFreshness(input, call.name), expandQueries: true, signal })).map(({ id, title, url, snippet, publisher, publishedAt }) => ({
        id,
        title,
        url,
        snippet,
        publisher,
        ...(publishedAt ? { publishedAt } : {}),
      }));
      return { id: call.id, name: call.name, ok: true, stdout: "", stderr: "", durationMs: Date.now() - startedAt, web: { kind: "search", query, results } };
    }
    if (call.name === FETCH_PAGE_TOOL_NAME) {
      requireOnly(input, ["url"], call.name);
      const url = text(input.url, 2_000); if (!/^https?:\/\//i.test(url)) throw new Error("fetch_page requires an http(s) URL.");
      const fetched = await fetchResearchPage(url, signal);
      const markdown = fetched.page.markdown.slice(0, webFetchMaxMarkdownCharacters());
      return { id: call.id, name: call.name, ok: true, stdout: "", stderr: "", durationMs: Date.now() - startedAt, web: { kind: "page", source: sourceForUrl({ title: fetched.page.source.title, url: fetched.page.source.url, snippet: markdown.slice(0, MAX_SNIPPET), publishedAt: fetched.page.source.publishedAt }), markdown } };
    }
    throw new Error(`Unknown tool: ${call.name}`);
  } catch (error) {
    const message = error instanceof SearchUnavailableError || error instanceof SearchNoResultsError
      ? error.message
      : error instanceof Error ? error.message : "Web tool failed.";
    return { id: call.id, name: call.name, ok: false, stdout: "", stderr: message, durationMs: Date.now() - startedAt };
  }
}
