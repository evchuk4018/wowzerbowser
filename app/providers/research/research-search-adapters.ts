import "server-only";
import { sourceForUrl } from "../../../lib/chat-citations";
import { configuredKeys, withProviderKeys } from "../../server/agent/web-api-key-pool";
import type { ResearchQuery, SearchCandidate } from "../../server/research/research-types";

const TIMEOUT_MS = 12_000;
const MAX_RESULTS = 20;
const text = (value: unknown, maximum = 2_000): string => typeof value === "string" ? value.trim().slice(0, maximum) : "";
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};

async function request(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

function candidate(input: {
  title: unknown; url: unknown; snippet?: unknown; publishedAt?: unknown; provider: string;
  queryIndex: number; rank: number; intent: ResearchQuery["intent"]; extraSnippets?: unknown;
}): SearchCandidate | null {
  const url = text(input.url);
  if (!/^https?:\/\//i.test(url)) return null;
  return {
    ...sourceForUrl({ title: text(input.title, 300), url, snippet: text(input.snippet, 1_500), publishedAt: text(input.publishedAt, 100) }),
    provider: input.provider,
    queryIndex: input.queryIndex,
    rank: input.rank,
    intent: input.intent,
    extraSnippets: array(input.extraSnippets).map((item) => text(item, 1_000)).filter(Boolean).slice(0, 5),
  };
}

function freshness(value?: ResearchQuery["freshness"]): string | undefined {
  return value ? { day: "pd", week: "pw", month: "pm", year: "py" }[value] : undefined;
}

export async function searchBrave(query: ResearchQuery, queryIndex: number, page = 0): Promise<SearchCandidate[]> {
  const params = new URLSearchParams({
    q: query.query,
    count: String(MAX_RESULTS),
    offset: String(Math.max(0, Math.min(9, Math.floor(page)))),
    extra_snippets: "true",
    text_decorations: "false",
    result_filter: query.intent === "community" ? "web,discussions" : query.intent === "recent" ? "web,news" : "web",
  });
  const fresh = freshness(query.freshness);
  if (fresh) params.set("freshness", fresh);
  const goggles = process.env[`BRAVE_GOGGLES_${query.intent.toUpperCase()}`]?.trim();
  if (goggles) params.set("goggles", goggles);
  const response = await withProviderKeys(configuredKeys("brave"), (key) => request(
    `https://api.search.brave.com/res/v1/web/search?${params}`,
    { headers: { Accept: "application/json", "X-Subscription-Token": key } },
  ));
  if (!response.ok) throw response;
  const body = record(await response.json());
  const web = record(body.web);
  const news = record(body.news);
  return [...array(web.results), ...array(news.results)].map((item, rank) => {
    const row = record(item);
    return candidate({ title: row.title, url: row.url, snippet: row.description, publishedAt: row.page_age ?? row.age, extraSnippets: row.extra_snippets, provider: "brave", queryIndex, rank: rank + 1, intent: query.intent });
  }).filter((item): item is SearchCandidate => Boolean(item)).slice(0, MAX_RESULTS);
}

export async function searchJina(query: ResearchQuery, queryIndex: number): Promise<SearchCandidate[]> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (process.env.JINA_API_KEY?.trim()) headers.Authorization = `Bearer ${process.env.JINA_API_KEY.trim()}`;
  const response = await request(`https://s.jina.ai/${encodeURIComponent(query.query)}`, { headers });
  if (!response.ok) throw response;
  const body = record(await response.json());
  return array(body.data).map((item, rank) => {
    const row = record(item);
    return candidate({ title: row.title, url: row.url, snippet: row.description ?? row.content, provider: "jina", queryIndex, rank: rank + 1, intent: query.intent });
  }).filter((item): item is SearchCandidate => Boolean(item)).slice(0, MAX_RESULTS);
}

export async function searchExa(query: ResearchQuery, queryIndex: number): Promise<SearchCandidate[]> {
  const response = await withProviderKeys(configuredKeys("exa"), (key) => request("https://api.exa.ai/search", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key },
    body: JSON.stringify({ query: query.query, type: "auto", numResults: 10, contents: { highlights: { maxCharacters: 1_200 } } }),
  }));
  if (!response.ok) throw response;
  return array(record(await response.json()).results).map((item, rank) => {
    const row = record(item);
    return candidate({ title: row.title, url: row.url, snippet: array(row.highlights).join(" ") || row.text, publishedAt: row.publishedDate, provider: "exa-search", queryIndex, rank: rank + 1, intent: query.intent });
  }).filter((item): item is SearchCandidate => Boolean(item));
}

export async function searchOpenAlex(query: ResearchQuery, queryIndex: number): Promise<SearchCandidate[]> {
  const params = new URLSearchParams({ search: query.query, "per-page": "20" });
  if (process.env.OPENALEX_MAILTO?.trim()) params.set("mailto", process.env.OPENALEX_MAILTO.trim());
  const response = await request(`https://api.openalex.org/works?${params}`);
  if (!response.ok) throw response;
  const body = record(await response.json());
  return array(body.results).map((item, rank) => {
    const row = record(item);
    const primary = record(row.primary_location);
    return candidate({ title: row.display_name, url: row.doi ?? primary.landing_page_url ?? row.id, snippet: row.abstract, publishedAt: row.publication_date, provider: "openalex", queryIndex, rank: rank + 1, intent: query.intent });
  }).filter((item): item is SearchCandidate => Boolean(item));
}

export async function searchCrossref(query: ResearchQuery, queryIndex: number): Promise<SearchCandidate[]> {
  const response = await request(`https://api.crossref.org/works?${new URLSearchParams({ query: query.query, rows: "20", select: "DOI,title,URL,abstract,published" })}`);
  if (!response.ok) throw response;
  const body = record(await response.json());
  return array(record(body.message).items).map((item, rank) => {
    const row = record(item);
    const parts = array(record(row.published)["date-parts"])[0];
    const publishedAt = Array.isArray(parts) ? parts.join("-") : undefined;
    return candidate({ title: array(row.title)[0], url: row.URL, snippet: row.abstract, publishedAt, provider: "crossref", queryIndex, rank: rank + 1, intent: query.intent });
  }).filter((item): item is SearchCandidate => Boolean(item));
}

export async function searchSemanticScholar(query: ResearchQuery, queryIndex: number): Promise<SearchCandidate[]> {
  const headers: Record<string, string> = {};
  if (process.env.SEMANTIC_SCHOLAR_API_KEY?.trim()) headers["x-api-key"] = process.env.SEMANTIC_SCHOLAR_API_KEY.trim();
  const params = new URLSearchParams({ query: query.query, limit: "20", fields: "title,url,abstract,publicationDate,externalIds" });
  const response = await request(`https://api.semanticscholar.org/graph/v1/paper/search?${params}`, { headers });
  if (!response.ok) throw response;
  return array(record(await response.json()).data).map((item, rank) => {
    const row = record(item);
    return candidate({ title: row.title, url: row.url, snippet: row.abstract, publishedAt: row.publicationDate, provider: "semantic-scholar", queryIndex, rank: rank + 1, intent: query.intent });
  }).filter((item): item is SearchCandidate => Boolean(item));
}

export async function searchMediaWiki(query: ResearchQuery, queryIndex: number): Promise<SearchCandidate[]> {
  const params = new URLSearchParams({ action: "query", generator: "search", gsrsearch: query.query, gsrlimit: "20", prop: "extracts|info", exintro: "1", explaintext: "1", inprop: "url", format: "json", origin: "*" });
  const response = await request(`https://en.wikipedia.org/w/api.php?${params}`);
  if (!response.ok) throw response;
  const pages = Object.values(record(record(await response.json()).query).pages ?? {});
  return pages.map((item, rank) => {
    const row = record(item);
    return candidate({ title: row.title, url: row.fullurl, snippet: row.extract, provider: "mediawiki", queryIndex, rank: rank + 1, intent: query.intent });
  }).filter((item): item is SearchCandidate => Boolean(item));
}

export async function searchGdelt(query: ResearchQuery, queryIndex: number): Promise<SearchCandidate[]> {
  if (process.env.GDELT_ENABLED !== "true") return [];
  const params = new URLSearchParams({ query: query.query, mode: "ArtList", maxrecords: "20", format: "json", sort: "HybridRel" });
  const response = await request(`https://api.gdeltproject.org/api/v2/doc/doc?${params}`);
  if (!response.ok) throw response;
  return array(record(await response.json()).articles).map((item, rank) => {
    const row = record(item);
    return candidate({ title: row.title, url: row.url, snippet: row.seendate, publishedAt: row.seendate, provider: "gdelt", queryIndex, rank: rank + 1, intent: query.intent });
  }).filter((item): item is SearchCandidate => Boolean(item));
}

export async function searchGitHub(query: ResearchQuery, queryIndex: number): Promise<SearchCandidate[]> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (process.env.GITHUB_TOKEN?.trim()) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN.trim()}`;
  const calls = [
    request(`https://api.github.com/search/repositories?${new URLSearchParams({ q: query.query, per_page: "10" })}`, { headers }),
    request(`https://api.github.com/search/issues?${new URLSearchParams({ q: query.query, per_page: "10" })}`, { headers }),
    ...(process.env.GITHUB_TOKEN?.trim() ? [request(`https://api.github.com/search/code?${new URLSearchParams({ q: query.query, per_page: "10" })}`, { headers })] : []),
  ];
  const responses = await Promise.allSettled(calls);
  const payloads: Array<{ kind: "repository" | "issue" | "code"; items: unknown[] }> = [];
  for (const [index, settled] of responses.entries()) {
    if (settled.status !== "fulfilled" || !settled.value.ok) continue;
    payloads.push({ kind: index === 0 ? "repository" : index === 1 ? "issue" : "code", items: array(record(await settled.value.json()).items) });
  }
  const repositories = payloads.find((payload) => payload.kind === "repository")?.items ?? [];
  const releaseResponses = await Promise.allSettled(repositories.slice(0, 3).map((item) => {
    const fullName = text(record(item).full_name, 300);
    return fullName ? request(`https://api.github.com/repos/${fullName}/releases?per_page=5`, { headers }) : Promise.reject(new Error("missing repository"));
  }));
  const releases: unknown[] = [];
  for (const settled of releaseResponses) if (settled.status === "fulfilled" && settled.value.ok) releases.push(...array(await settled.value.json()));
  const rows = [
    ...payloads.flatMap((payload) => payload.items.map((item) => ({ item, kind: payload.kind }))),
    ...releases.map((item) => ({ item, kind: "release" })),
  ];
  return rows.map(({ item, kind }, rank) => {
    const row = record(item);
    return candidate({
      title: row.full_name ?? row.name ?? row.title ?? `${record(row.repository).full_name ?? "GitHub"} ${kind}`,
      url: row.html_url,
      snippet: row.description ?? row.body ?? row.path ?? row.tag_name,
      publishedAt: row.published_at ?? row.updated_at,
      provider: "github", queryIndex, rank: rank + 1, intent: query.intent,
    });
  }).filter((item): item is SearchCandidate => Boolean(item));
}

export async function rerankWithJina(query: string, candidates: SearchCandidate[]): Promise<SearchCandidate[]> {
  if (!process.env.JINA_API_KEY?.trim() || candidates.length < 2) return candidates;
  const response = await request("https://api.jina.ai/v1/rerank", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${process.env.JINA_API_KEY.trim()}` },
    body: JSON.stringify({ model: "jina-reranker-v2-base-multilingual", query, documents: candidates.slice(0, 30).map((item) => `${item.title}\n${item.snippet}`), top_n: Math.min(30, candidates.length) }),
  });
  if (!response.ok) return candidates;
  const scores = new Map<number, number>();
  for (const item of array(record(await response.json()).results)) {
    const row = record(item);
    if (typeof row.index === "number" && typeof row.relevance_score === "number") scores.set(row.index, row.relevance_score);
  }
  return candidates.map((item, index) => ({ ...item, score: scores.get(index) ?? item.score }));
}
