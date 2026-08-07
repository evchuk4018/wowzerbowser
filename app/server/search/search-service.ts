import "server-only";

import type { SearchFocus } from "../../../lib/search-protocol";
import { searchMediaWiki } from "../../providers/search/mediawiki-search-adapter";
import { searchMiniflux } from "../../providers/search/miniflux-search-adapter";
import { searchSearXNG, searchSearXNGReddit } from "../../providers/search/searxng-search-adapter";
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
  constructor(failedProviders: SearchProviderName[] = []) {
    super(failedProviders.length ? `Search providers are unavailable (${failedProviders.join(", ")}).` : "Search providers are unavailable.");
    this.name = "SearchUnavailableError";
  }
}

export class SearchNoResultsError extends Error {
  constructor() {
    super("No search results were found.");
    this.name = "SearchNoResultsError";
  }
}

type ProviderState = "fulfilled-with-results" | "fulfilled-empty" | "rejected";

type ProviderOutcome = {
  name: SearchProviderName;
  state: ProviderState;
  candidates: SearchCandidate[];
  error?: unknown;
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
  const queries: SearchProviderQuery[] = plans.map((planned) => ({
    query: planned.query,
    focus,
    count,
    queryIndex: planned.queryIndex,
    intent: planned.intent,
    ...(planned.freshness ? { freshness: planned.freshness } : {}),
    relevanceQuery: planned.relevanceQuery,
  }));
  const providers: Array<[SearchProviderName, SearchProviderQuery, () => Promise<SearchCandidate[]>]> = queries.flatMap((query) => [
    ["searxng", query, () => searchSearXNG(query, input.signal)] as [SearchProviderName, SearchProviderQuery, () => Promise<SearchCandidate[]>],
    ["searxng-reddit", query, () => searchSearXNGReddit(query, input.signal)] as [SearchProviderName, SearchProviderQuery, () => Promise<SearchCandidate[]>],
    ["mediawiki", query, () => searchMediaWiki(query, input.signal)] as [SearchProviderName, SearchProviderQuery, () => Promise<SearchCandidate[]>],
    ["miniflux", query, () => searchMiniflux(query, input.signal)] as [SearchProviderName, SearchProviderQuery, () => Promise<SearchCandidate[]>],
  ]);
  const outcomes: ProviderOutcome[] = await Promise.all(providers.map(async ([name, query, request]): Promise<ProviderOutcome> => {
    try {
      const candidates = filterCandidates(await searchProviderWithReliability({ provider: name, query, signal: input.signal, execute: request }), query);
      return { name, state: candidates.length ? "fulfilled-with-results" : "fulfilled-empty", candidates };
    } catch (error) {
      console.warn(`[search] provider ${name} rejected: ${providerErrorMessage(error)}`);
      return { name, state: "rejected", candidates: [], error };
    }
  }));
  const failedProviders = [...new Set(outcomes.filter((outcome) => outcome.state === "rejected").map((outcome) => outcome.name))];
  const candidates = outcomes.flatMap((outcome) => outcome.candidates);
  if (failedProviders.length && candidates.length) console.warn(`[search] partial provider failures: ${failedProviders.join(", ")}`);
  if (!candidates.length) {
    if (failedProviders.length) throw new SearchUnavailableError(failedProviders);
    throw new SearchNoResultsError();
  }
  return rankSearchCandidates(candidates, { focus, maxResults: count });
}
