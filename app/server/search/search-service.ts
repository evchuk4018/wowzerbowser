import "server-only";

import type { SearchFocus } from "../../../lib/search-protocol";
import { canonicalSourceUrl } from "../../../lib/chat-citations";
import { searchMediaWiki } from "../../providers/search/mediawiki-search-adapter";
import { searchMiniflux } from "../../providers/search/miniflux-search-adapter";
import { searchRedlib } from "../../providers/search/redlib-search-adapter";
import { searchSearXNG } from "../../providers/search/searxng-search-adapter";
import type { SearchCandidate, SearchProviderName, SearchProviderQuery } from "./search-types";

const PROVIDER_WEIGHTS: Record<SearchFocus, Record<SearchProviderName, number>> = {
  general: { searxng: 1, redlib: 0.9, mediawiki: 0.9, miniflux: 0.9 },
  news: { searxng: 1, redlib: 0.65, mediawiki: 0.55, miniflux: 1.55 },
  community: { searxng: 0.85, redlib: 1.55, mediawiki: 0.6, miniflux: 0.65 },
  reference: { searxng: 0.85, redlib: 0.55, mediawiki: 1.6, miniflux: 0.6 },
};

const RELEVANCE_STOP_WORDS = new Set([
  "a", "about", "an", "and", "are", "at", "be", "by", "for", "from", "how", "in", "is", "it", "me",
  "of", "on", "or", "please", "search", "tell", "the", "to", "what", "when", "where", "which", "who", "why",
  "with",
]);

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

function lexicalTokens(value: string): string[] {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("en-US")
    .split(/[^\p{L}\p{N}]+/gu)
    .filter((token) => token.length > 1 && !RELEVANCE_STOP_WORDS.has(token));
}

function mediaWikiCandidateIsRelevant(item: SearchCandidate, query: string): boolean {
  const queryTerms = new Set(lexicalTokens(query));
  if (!queryTerms.size) return false;
  const resultTerms = new Set(lexicalTokens(`${item.title} ${item.snippet}`));
  let matches = 0;
  for (const term of queryTerms) if (resultTerms.has(term)) matches += 1;
  return matches >= Math.min(2, queryTerms.size);
}

function filterCandidates(candidates: SearchCandidate[], query: SearchProviderQuery): SearchCandidate[] {
  if (query.focus === "reference") return candidates;
  return candidates.filter((item) => item.provider !== "mediawiki" || mediaWikiCandidateIsRelevant(item, query.query));
}

function providerErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.slice(0, 240);
  return "unknown provider error";
}

function rankCandidates(candidates: SearchCandidate[], focus: SearchFocus, count: number): SearchCandidate[] {
  const weights = PROVIDER_WEIGHTS[focus];
  const scored = candidates.map((item) => ({
    item,
    score: weights[item.provider] / (30 + item.rank),
  })).sort((left, right) => right.score - left.score);
  const unique = new Map<string, SearchCandidate>();
  for (const { item, score } of scored) {
    const key = canonicalSourceUrl(item.url);
    const previous = unique.get(key);
    if (!previous || score > (previous.score ?? 0)) unique.set(key, { ...item, score });
  }
  const domains = new Map<string, number>();
  return [...unique.values()].map((item) => {
    let domain = "";
    try { domain = new URL(item.url).hostname.replace(/^www\./, "").toLowerCase(); } catch {}
    const repeats = domains.get(domain) ?? 0;
    domains.set(domain, repeats + 1);
    return { ...item, score: (item.score ?? 0) - repeats * 0.015 };
  }).sort((left, right) => (right.score ?? 0) - (left.score ?? 0)).slice(0, count);
}

export async function searchSelfHosted(input: {
  query: string;
  focus?: SearchFocus;
  count?: number;
  queryIndex?: number;
  intent?: string;
  freshness?: SearchProviderQuery["freshness"];
  signal?: AbortSignal;
}): Promise<SearchCandidate[]> {
  const query: SearchProviderQuery = {
    query: input.query,
    focus: input.focus ?? "general",
    count: Math.max(1, Math.min(20, input.count ?? 20)),
    queryIndex: input.queryIndex ?? 0,
    intent: input.intent ?? "general",
    ...(input.freshness ? { freshness: input.freshness } : {}),
  };
  const providers: Array<[SearchProviderName, Promise<SearchCandidate[]>]> = [
    ["searxng", searchSearXNG(query, input.signal)],
    ["redlib", searchRedlib(query, input.signal)],
    ["mediawiki", searchMediaWiki(query, input.signal)],
    ["miniflux", searchMiniflux(query, input.signal)],
  ];
  const outcomes: ProviderOutcome[] = await Promise.all(providers.map(async ([name, request]): Promise<ProviderOutcome> => {
    try {
      const candidates = filterCandidates(await request, query);
      return { name, state: candidates.length ? "fulfilled-with-results" : "fulfilled-empty", candidates };
    } catch (error) {
      console.warn(`[search] provider ${name} rejected: ${providerErrorMessage(error)}`);
      return { name, state: "rejected", candidates: [], error };
    }
  }));
  const failedProviders = outcomes.filter((outcome) => outcome.state === "rejected").map((outcome) => outcome.name);
  const candidates = outcomes.flatMap((outcome) => outcome.candidates);
  if (failedProviders.length && candidates.length) console.warn(`[search] partial provider failures: ${failedProviders.join(", ")}`);
  if (!candidates.length) {
    if (failedProviders.length) throw new SearchUnavailableError(failedProviders);
    throw new SearchNoResultsError();
  }
  return rankCandidates(candidates, query.focus, query.count);
}
