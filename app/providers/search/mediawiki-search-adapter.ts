import "server-only";

import type { SearchCandidate, SearchProviderQuery } from "../../server/search/search-types";
import { record, requireOk, searchRequest } from "./search-http";
import { candidate } from "./search-candidate";
import { runtimeConfigSnapshot } from "../../server/config/runtime-config-service";

export async function searchMediaWiki(query: SearchProviderQuery, signal?: AbortSignal): Promise<SearchCandidate[]> {
  const base = runtimeConfigSnapshot().mediawikiApiUrl;
  const endpoint = new URL(base);
  endpoint.search = new URLSearchParams({
    action: "query",
    generator: "search",
    gsrsearch: query.query,
    gsrlimit: String(query.count),
    prop: "extracts|info",
    exintro: "1",
    explaintext: "1",
    inprop: "url",
    format: "json",
    origin: "*",
  }).toString();
  const response = await searchRequest(endpoint.toString(), { headers: { Accept: "application/json", "User-Agent": "wowzerbowser-search/1.0" } }, signal);
  requireOk(response, "MediaWiki");
  const pages = Object.values(record(record(await response.json()).query).pages ?? {});
  return pages.map((item, index) => {
    const row = record(item);
    return candidate({ title: row.title, url: row.fullurl, snippet: row.extract, provider: "mediawiki", query, rank: index + 1 });
  }).filter((item): item is SearchCandidate => Boolean(item)).slice(0, query.count);
}
