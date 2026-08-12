import "server-only";

import { createHash } from "node:crypto";
import type { SearchFocus } from "../../../lib/search-protocol";
import { searchMiniflux } from "../../providers/search/miniflux-search-adapter";
import { searchSearXNG, searchSearXNGReddit, searchSearXNGWikipedia } from "../../providers/search/searxng-search-adapter";
import { rankSearchCandidates } from "./search-ranking";
import { isSearchCandidateRelevant, scoreSearchCandidate } from "./search-relevance";
import { searchProviderWithReliability } from "./search-provider-reliability";
import { planSearchQueries, type PlannedSearchQuery } from "./search-query-planner";
import type { SearchCandidate, SearchProviderName, SearchProviderQuery } from "./search-types";
import { runtimeConfigSnapshot } from "../config/runtime-config-service";

const MAX_SEARCH_RESULTS = 50;
type WebSearchLimitKey =
  | "webSearchMaxResultsGeneral"
  | "webSearchMaxResultsNews"
  | "webSearchMaxResultsCommunity"
  | "webSearchMaxResultsReference";

function configuredSearchMaxResults(focus: SearchFocus): number {
  const key: WebSearchLimitKey = focus === "news"
    ? "webSearchMaxResultsNews"
    : focus === "community"
      ? "webSearchMaxResultsCommunity"
      : focus === "reference"
        ? "webSearchMaxResultsReference"
        : "webSearchMaxResultsGeneral";
  const value = (runtimeConfigSnapshot() as unknown as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isSafeInteger(value)
    ? Math.max(1, Math.min(MAX_SEARCH_RESULTS, value))
    : MAX_SEARCH_RESULTS;
}

export class SearchUnavailableError extends Error {
  constructor(failedProviders: SearchProviderName[] = [], reasons: string[] = []) {
    const details = [...new Set(reasons.map((reason) => reason.replace(/\s+/gu, " ").trim()).filter(Boolean))]
      .join("; ")
      .slice(0, 500);
    const providers = failedProviders.length ? failedProviders.join(", ") : "unknown provider";
    super(`Search providers are temporarily unavailable (${providers}${details ? `: ${details}` : ""}). Do not retry web_search in this response. State that current web results could not be verified and do not invent results.`);
    this.name = "SearchUnavailableError";
  }
}

export class SearchNoResultsError extends Error {
  constructor() {
    super("No relevant search results were found.");
    this.name = "SearchNoResultsError";
  }
}

type ProviderState = "fulfilled-with-results" | "fulfilled-empty" | "rejected";

type ProviderOutcome = {
  name: SearchProviderName;
  state: ProviderState;
  candidates: SearchCandidate[];
  rawCount: number;
  error?: unknown;
};

type ProviderRequest = {
  name: SearchProviderName;
  cacheNamespace: string;
  circuitProvider: SearchProviderName;
  query: SearchProviderQuery;
  request: () => Promise<SearchCandidate[]>;
};

function providerErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.slice(0, 240);
  return "unknown provider error";
}

function filterCandidates(candidates: SearchCandidate[], query: SearchProviderQuery): SearchCandidate[] {
  const relevanceQuery = query.relevanceQuery ?? query.query;
  return candidates.flatMap((item) => {
    const relevanceScore = scoreSearchCandidate(item, relevanceQuery);
    return isSearchCandidateRelevant(item, relevanceQuery) ? [{ ...item, relevanceScore }] : [];
  });
}

function queryHash(query: string): string {
  return createHash("sha256").update(query).digest("hex").slice(0, 16);
}

function providersFor(query: SearchProviderQuery, signal?: AbortSignal): ProviderRequest[] {
  if (query.focus === "community") {
    return [{ name: "searxng-reddit", cacheNamespace: "reddit", circuitProvider: "searxng", query, request: () => searchSearXNGReddit(query, signal) }];
  }
  if (query.focus === "reference") {
    return [{ name: "searxng", cacheNamespace: "wikipedia", circuitProvider: "searxng", query, request: () => searchSearXNGWikipedia(query, signal) }];
  }
  const providers: ProviderRequest[] = [
    { name: "searxng", cacheNamespace: "general", circuitProvider: "searxng", query, request: () => searchSearXNG(query, signal) },
  ];
  if (query.focus === "news") providers.push({ name: "miniflux", cacheNamespace: "news", circuitProvider: "miniflux", query, request: () => searchMiniflux(query, signal) });
  return providers;
}

async function runQuery(query: SearchProviderQuery, signal?: AbortSignal): Promise<ProviderOutcome[]> {
  return Promise.all(providersFor(query, signal).map(async ({ name, cacheNamespace, circuitProvider, request }): Promise<ProviderOutcome> => {
    const startedAt = Date.now();
    try {
      const raw = await searchProviderWithReliability({ provider: name, cacheNamespace, circuitProvider, query, signal, execute: request });
      const candidates = filterCandidates(raw, query);
      console.info(JSON.stringify({
        event: "search_provider_result",
        provider: name,
        cacheNamespace,
        queryHash: queryHash(query.query),
        rawCount: raw.length,
        filteredCount: candidates.length,
        latencyMs: Date.now() - startedAt,
      }));
      return { name, state: candidates.length ? "fulfilled-with-results" : "fulfilled-empty", candidates, rawCount: raw.length };
    } catch (error) {
      console.warn(`[search] provider ${name} rejected: ${providerErrorMessage(error)}`);
      return { name, state: "rejected", candidates: [], rawCount: 0, error };
    }
  }));
}

function unavailableFrom(outcomes: ProviderOutcome[]): SearchUnavailableError {
  const rejected = outcomes.filter((outcome) => outcome.state === "rejected");
  return new SearchUnavailableError(
    [...new Set(rejected.map((outcome) => outcome.name))],
    rejected.flatMap((outcome) => outcome.error instanceof Error ? [outcome.error.message] : []),
  );
}

export async function searchSelfHosted(input: {
  query: string;
  focus?: SearchFocus;
  count?: number;
  queryIndex?: number;
  intent?: string;
  freshness?: SearchProviderQuery["freshness"];
  expandQueries?: boolean;
  signal?: AbortSignal;
}): Promise<SearchCandidate[]> {
  const focus = input.focus ?? "general";
  const queryIndex = input.queryIndex ?? 0;
  const maxResults = configuredSearchMaxResults(focus);
  const count = Math.max(1, Math.min(maxResults, Number(input.count ?? maxResults) || maxResults));
  const plans: PlannedSearchQuery[] = input.expandQueries
    ? planSearchQueries({
      query: input.query,
      focus,
      freshness: input.freshness,
      queryIndex,
      intent: input.intent,
    })
    : [{
      query: input.query,
      queryIndex,
      intent: input.intent ?? "general",
      ...(input.freshness ? { freshness: input.freshness } : {}),
      relevanceQuery: input.query,
    }];
  const queries: SearchProviderQuery[] = plans.slice(0, input.expandQueries ? 2 : 1).map((planned) => ({
    query: planned.query,
    focus,
    count,
    queryIndex: planned.queryIndex,
    intent: planned.intent,
    ...(planned.freshness ? { freshness: planned.freshness } : {}),
    relevanceQuery: planned.relevanceQuery,
  }));
  if (!queries.length) throw new SearchNoResultsError();
  let outcomes = await runQuery(queries[0], input.signal);
  const healthyGenuineEmpty = outcomes.every((outcome) => outcome.state === "fulfilled-empty" && outcome.rawCount === 0);
  if (healthyGenuineEmpty && queries[1]) outcomes = await runQuery(queries[1], input.signal);
  const failedProviders = [...new Set(outcomes.filter((outcome) => outcome.state === "rejected").map((outcome) => outcome.name))];
  const candidates = outcomes.flatMap((outcome) => outcome.candidates);
  if (failedProviders.length && candidates.length) console.warn(`[search] partial provider failures: ${failedProviders.join(", ")}`);
  if (!candidates.length) {
    if (failedProviders.length) throw unavailableFrom(outcomes);
    throw new SearchNoResultsError();
  }
  return rankSearchCandidates(candidates, { focus, maxResults: count });
}
