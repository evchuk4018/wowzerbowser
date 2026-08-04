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

export class SearchUnavailableError extends Error {
  constructor() { super("The self-hosted search stack is temporarily unavailable."); }
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
  const results = await Promise.allSettled([
    searchSearXNG(query, input.signal),
    searchRedlib(query, input.signal),
    searchMediaWiki(query, input.signal),
    searchMiniflux(query, input.signal),
  ]);
  const candidates = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  if (!candidates.length) throw new SearchUnavailableError();
  return rankCandidates(candidates, query.focus, query.count);
}
