import "server-only";

import type { SearchCandidate, SearchProviderQuery } from "../../server/search/search-types";
import { array, record, requireOk, searchRequest } from "./search-http";
import { candidate } from "./search-candidate";
import { runtimeConfigSnapshot } from "../../server/config/runtime-config-service";

function broadNewsQuery(query: SearchProviderQuery): boolean {
  if (query.focus !== "news") return false;
  const normalized = query.query.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return /^(?:the )?(?:top|latest|breaking|current|today'?s?)?(?: news| headlines| stories)?(?: today| now)?$/.test(normalized)
    || /^(?:search up|look up|find) (?:the )?news$/.test(normalized);
}

function plainText(value: unknown): string {
  return typeof value === "string" ? value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "";
}

export async function searchMiniflux(query: SearchProviderQuery, signal?: AbortSignal): Promise<SearchCandidate[]> {
  const base = runtimeConfigSnapshot().minifluxUrl;
  const endpoint = new URL("/v1/entries", `${base.replace(/\/$/, "")}/`);
  endpoint.search = new URLSearchParams({
    ...(broadNewsQuery(query) ? {} : { search: query.query }),
    limit: String(query.count),
    order: "published_at",
    direction: "desc",
  }).toString();
  const token = process.env.MINIFLUX_API_TOKEN?.trim();
  const username = process.env.MINIFLUX_API_USERNAME?.trim() || process.env.MINIFLUX_ADMIN_USERNAME?.trim();
  const password = process.env.MINIFLUX_API_PASSWORD ?? process.env.MINIFLUX_ADMIN_PASSWORD;
  const basic = username && password !== undefined
    ? `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
    : undefined;
  const response = await searchRequest(endpoint.toString(), {
    headers: { Accept: "application/json", ...(token ? { "X-Auth-Token": token } : basic ? { Authorization: basic } : {}) },
  }, signal);
  requireOk(response, "Miniflux");
  const body = record(await response.json());
  return array(body.entries).map((item, index) => {
    const row = record(item);
    return candidate({
      title: row.title,
      url: row.url ?? row.external_url,
      snippet: plainText(row.content ?? row.description),
      publishedAt: row.published_at ?? row.created_at,
      provider: "miniflux",
      query,
      rank: index + 1,
    });
  }).filter((item): item is SearchCandidate => Boolean(item)).slice(0, query.count);
}
