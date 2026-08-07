import "server-only";

import type { SearchCandidate, SearchProviderQuery } from "../../server/search/search-types";
import { array, record, requireOk, searchRequest } from "./search-http";
import { candidate } from "./search-candidate";
import { runtimeConfigSnapshot } from "../../server/config/runtime-config-service";

const FRESHNESS: Record<NonNullable<SearchProviderQuery["freshness"]>, string> = {
  day: "day",
  week: "week",
  month: "month",
  year: "year",
};

type SearXNGProvider = Extract<SearchCandidate["provider"], "searxng" | "searxng-reddit">;
type CandidateFilter = (item: SearchCandidate) => boolean;

function isRedditUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
    return hostname === "reddit.com" || hostname.endsWith(".reddit.com") || hostname === "redd.it";
  } catch {
    return false;
  }
}

async function searchSearXNGWithProvider(
  query: SearchProviderQuery,
  provider: SearXNGProvider,
  signal?: AbortSignal,
  filter?: CandidateFilter,
): Promise<SearchCandidate[]> {
  const base = runtimeConfigSnapshot().searxngUrl;
  const endpoint = new URL("/search", `${base.replace(/\/$/, "")}/`);
  const form = new URLSearchParams({
    q: query.query,
    format: "json",
    categories: query.focus === "news" ? "news" : "general",
    pageno: "1",
    ...(query.freshness ? { time_range: FRESHNESS[query.freshness] } : {}),
  });
  const response = await searchRequest(endpoint.toString(), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  }, signal);
  requireOk(response, "SearXNG");
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("json")) throw new Error("SearXNG search returned a non-JSON response.");
  const body = record(await response.json());
  const results: SearchCandidate[] = [];
  let upstreamRank = 0;
  for (const item of array(body.results)) {
    upstreamRank += 1;
    const row = record(item);
    const result = candidate({
      title: row.title,
      url: row.url,
      snippet: row.content ?? row.description,
      publishedAt: row.publishedDate ?? row.published_at,
      provider,
      query,
      rank: upstreamRank,
      extraSnippets: row.engines,
    });
    if (!result || (filter && !filter(result))) continue;
    results.push(result);
    if (results.length >= query.count) break;
  }
  return results;
}

export async function searchSearXNG(query: SearchProviderQuery, signal?: AbortSignal): Promise<SearchCandidate[]> {
  return searchSearXNGWithProvider(query, "searxng", signal);
}

export async function searchSearXNGReddit(query: SearchProviderQuery, signal?: AbortSignal): Promise<SearchCandidate[]> {
  const redditQuery: SearchProviderQuery = { ...query, query: `${query.query.trim()} reddit` };
  return searchSearXNGWithProvider(redditQuery, "searxng-reddit", signal, (item) => isRedditUrl(item.url));
}
