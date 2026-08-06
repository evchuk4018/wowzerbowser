import "server-only";

import type { SearchCandidate, SearchProviderQuery } from "../../server/search/search-types";
import { array, record, requireOk, searchRequest } from "./search-http";
import { candidate } from "./search-candidate";

const FRESHNESS: Record<NonNullable<SearchProviderQuery["freshness"]>, string> = {
  day: "day",
  week: "week",
  month: "month",
  year: "year",
};

export async function searchSearXNG(query: SearchProviderQuery, signal?: AbortSignal): Promise<SearchCandidate[]> {
  const base = process.env.SEARXNG_URL?.trim() || "http://searxng:8080";
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
  return array(body.results).map((item, index) => {
    const row = record(item);
    return candidate({
      title: row.title,
      url: row.url,
      snippet: row.content ?? row.description,
      publishedAt: row.publishedDate ?? row.published_at,
      provider: "searxng",
      query,
      rank: index + 1,
      extraSnippets: row.engines,
    });
  }).filter((item): item is SearchCandidate => Boolean(item)).slice(0, query.count);
}
