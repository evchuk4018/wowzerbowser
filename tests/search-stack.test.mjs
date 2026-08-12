import assert from "node:assert/strict";
import test from "node:test";
import { extractFirecrawl } from "../app/providers/research/research-page-adapters.ts";
import { searchMiniflux } from "../app/providers/search/miniflux-search-adapter.ts";
import { searchSearXNG, searchSearXNGReddit, searchSearXNGWikipedia } from "../app/providers/search/searxng-search-adapter.ts";
import { searchRequest } from "../app/providers/search/search-http.ts";
import { SearchNoResultsError, SearchUnavailableError, searchSelfHosted } from "../app/server/search/search-service.ts";
import { isSearchCandidateRelevant, scoreSearchCandidate } from "../app/server/search/search-relevance.ts";
import { resetSearchProviderReliability } from "../app/server/search/search-provider-reliability.ts";
import { planSearchQueries } from "../app/server/search/search-query-planner.ts";

process.env.SEARCH_PROVIDER_MIN_INTERVAL_MS = "0";

test("normal search planning expands only intent-bearing requests", () => {
  const lookup = planSearchQueries({ query: "what is TypeScript", focus: "general" });
  assert.equal(lookup.length, 1);

  const recommendation = planSearchQueries({ query: "best note taking apps", focus: "general" });
  assert.equal(recommendation.length, 3);
  assert.match(recommendation[1].query, /reviews comparison/);

  const current = planSearchQueries({ query: "AI releases", focus: "news", freshness: "week" });
  assert.equal(current.length, 3);
  assert.deepEqual(current.map(({ queryIndex }) => queryIndex), [0, 1, 2]);
  assert.deepEqual(current.map(({ freshness }) => freshness), ["week", "week", "week"]);
});

test("relevance scoring covers title and snippet overlap and rejects unrelated candidates", () => {
  const relevant = { title: "Self-hosted search guide", snippet: "A practical self-hosted search discussion." };
  const unrelated = { title: "Major League Soccer", snippet: "A professional football competition." };
  assert.ok(scoreSearchCandidate(relevant, "self hosted search") > 0.6);
  assert.equal(isSearchCandidateRelevant(relevant, "self hosted search"), true);
  assert.equal(scoreSearchCandidate(unrelated, "self hosted search"), 0);
  assert.equal(isSearchCandidateRelevant(unrelated, "self hosted search"), false);
});

test("search HTTP retries one transient failure", async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return calls === 1 ? new Response("temporary", { status: 503 }) : Response.json({ ok: true });
  };
  try {
    const response = await searchRequest("https://example.test/search", {}, undefined, 1_000);
    assert.equal(response.status, 200);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("successful provider results are cached for the short reliability window", async () => {
  const previousFetch = globalThis.fetch;
  const previousTtl = process.env.SEARCH_PROVIDER_CACHE_TTL_MS;
  let calls = 0;
  process.env.SEARCH_PROVIDER_CACHE_TTL_MS = "1000";
  resetSearchProviderReliability();
  globalThis.fetch = async (url) => {
    calls += 1;
    const value = String(url);
    if (value.includes("wikipedia")) return Response.json({ query: { pages: { "1": { title: "Cache reliability", fullurl: "https://example.com/cache", extract: "Cache reliability evidence" } } } });
    if (value.includes("miniflux")) return Response.json({ entries: [{ title: "Cache reliability", url: "https://example.com/cache", content: "Cache reliability evidence" }] });
    return Response.json({ results: [{ title: "Cache reliability", url: "https://example.com/cache", content: "Cache reliability evidence" }] });
  };
  try {
    const input = { query: "cache reliability", focus: "general", count: 5 };
    assert.ok((await searchSelfHosted(input)).length > 0);
    assert.ok((await searchSelfHosted(input)).length > 0);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = previousFetch;
    resetSearchProviderReliability();
    if (previousTtl === undefined) delete process.env.SEARCH_PROVIDER_CACHE_TTL_MS; else process.env.SEARCH_PROVIDER_CACHE_TTL_MS = previousTtl;
  }
});

test("a blocked provider opens its circuit immediately and suppresses repeat requests", async () => {
  const previousFetch = globalThis.fetch;
  const previousTtl = process.env.SEARCH_PROVIDER_CACHE_TTL_MS;
  let calls = 0;
  process.env.SEARCH_PROVIDER_CACHE_TTL_MS = "0";
  resetSearchProviderReliability();
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({ results: [], unresponsive_engines: [["duckduckgo", "CAPTCHA"]] });
  };
  try {
    const input = { query: "circuit breaker", focus: "general", count: 5 };
    await assert.rejects(searchSelfHosted(input), /CAPTCHA.*do not retry/i);
    await assert.rejects(searchSelfHosted(input), /temporarily unavailable.*do not retry/i);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = previousFetch;
    resetSearchProviderReliability();
    if (previousTtl === undefined) delete process.env.SEARCH_PROVIDER_CACHE_TTL_MS; else process.env.SEARCH_PROVIDER_CACHE_TTL_MS = previousTtl;
  }
});

test("queued SearXNG requests stop after the first request reports blocked engines", async () => {
  const previousFetch = globalThis.fetch;
  const originalNow = Date.now;
  const previousCircuitOpen = process.env.SEARCH_PROVIDER_CIRCUIT_OPEN_MS;
  let calls = 0;
  process.env.SEARCH_PROVIDER_CIRCUIT_OPEN_MS = "1000";
  resetSearchProviderReliability();
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return Response.json({ results: [], unresponsive_engines: [["duckduckgo", "CAPTCHA"]] });
    return Response.json({ results: [{ title: "Recovered provider", url: "https://example.com/recovered", content: "Provider recovered" }] });
  };
  try {
    const query = { query: "provider block", focus: "general", count: 5, queryIndex: 0, intent: "lookup" };
    const outcomes = await Promise.allSettled([
      searchSearXNG(query),
      searchSearXNGWikipedia({ ...query, focus: "reference", intent: "reference" }),
    ]);
    assert.deepEqual(outcomes.map(({ status }) => status), ["rejected", "rejected"]);
    assert.equal(calls, 1);
    assert.match(String(outcomes[1].reason), /CAPTCHA/);
    Date.now = () => originalNow() + 1_001;
    assert.equal((await searchSearXNG(query))[0]?.title, "Recovered provider");
    assert.equal(calls, 2);
  } finally {
    Date.now = originalNow;
    globalThis.fetch = previousFetch;
    resetSearchProviderReliability();
    if (previousCircuitOpen === undefined) delete process.env.SEARCH_PROVIDER_CIRCUIT_OPEN_MS; else process.env.SEARCH_PROVIDER_CIRCUIT_OPEN_MS = previousCircuitOpen;
  }
});

test("partial SearXNG results remain usable while engine failures are disclosed in diagnostics", async () => {
  const previousFetch = globalThis.fetch;
  resetSearchProviderReliability();
  globalThis.fetch = async () => Response.json({
    results: [{ title: "Search reliability guide", url: "https://example.com/search", content: "Search reliability evidence" }],
    unresponsive_engines: [["duckduckgo", "CAPTCHA"]],
  });
  try {
    const results = await searchSelfHosted({ query: "search reliability", focus: "general", count: 5 });
    assert.equal(results.length, 1);
  } finally {
    globalThis.fetch = previousFetch;
    resetSearchProviderReliability();
  }
});

test("general and Wikipedia searches use distinct cache namespaces", async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  resetSearchProviderReliability();
  globalThis.fetch = async (_url, init = {}) => {
    calls += 1;
    const engines = new URLSearchParams(init.body).get("engines");
    return Response.json({ results: [{
      title: engines ? "TypeScript Wikipedia reference" : "TypeScript general guide",
      url: engines ? "https://en.wikipedia.org/wiki/TypeScript" : "https://example.com/typescript",
      content: "TypeScript reference guide",
    }] });
  };
  try {
    await searchSelfHosted({ query: "TypeScript", focus: "general", count: 5 });
    await searchSelfHosted({ query: "TypeScript", focus: "reference", count: 5 });
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = previousFetch;
    resetSearchProviderReliability();
  }
});

test("expanded search runs only one conditional fallback after a healthy empty response", async () => {
  const previousFetch = globalThis.fetch;
  const queries = [];
  resetSearchProviderReliability();
  globalThis.fetch = async (_url, init = {}) => {
    const query = new URLSearchParams(init.body).get("q") ?? "";
    queries.push(query);
    if (queries.length === 1) return Response.json({ results: [] });
    return Response.json({ results: [{ title: "Best note taking apps comparison", url: "https://example.com/apps", content: "Reviews comparison of note taking apps" }] });
  };
  try {
    const results = await searchSelfHosted({ query: "best note taking apps", focus: "general", count: 5, expandQueries: true });
    assert.equal(results.length, 1);
    assert.deepEqual(queries, ["best note taking apps", "best note taking apps reviews comparison"]);
  } finally {
    globalThis.fetch = previousFetch;
    resetSearchProviderReliability();
  }
});

test("community search uses an exact SearXNG Reddit query and filters non-Reddit URLs", async () => {
  const previousFetch = globalThis.fetch;
  const previousUrl = process.env.SEARXNG_URL;
  const calls = [];
  process.env.SEARXNG_URL = "http://searxng:8080";
  globalThis.fetch = async (url, init = {}) => {
    const value = String(url);
    if (value.includes("searxng")) {
      const query = new URLSearchParams(init.body).get("q");
      calls.push({ url: value, init, query });
      if (query === "self hosted search reddit") return Response.json({ results: [
        { title: "Unrelated result", url: "https://example.com/not-reddit", content: "Should be filtered" },
        { title: "Self-hosted search", url: "https://www.reddit.com/r/selfhosted/comments/abc123/self_hosted_search/", content: "Community experience" },
        { title: "Suffix-confusion result", url: "https://reddit.com.evil.example/r/not-reddit", content: "Should be filtered" },
        { title: "Short Reddit link", url: "https://redd.it/def456", content: "Another self-hosted search result" },
        { title: "Trailing-dot Reddit link", url: "https://old.reddit.com./r/selfhosted/comments/ghi789/another_post", content: "A third self-hosted search discussion" },
      ] });
      throw new Error(`Unexpected SearXNG query: ${query}`);
    }
    if (value.includes("wikipedia")) return Response.json({ query: { pages: {} } });
    return Response.json({ entries: [] });
  };
  try {
    const results = await searchSelfHosted({ query: "self hosted search", focus: "community", count: 3, queryIndex: 0, intent: "community" });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls.map(({ query }) => query), ["self hosted search reddit"]);
    assert.equal(results.length, 3);
    assert.equal(results[0].provider, "searxng-reddit");
    assert.equal(results[0].rank, 2);
    assert.equal(results[0].url, "https://www.reddit.com/r/selfhosted/comments/abc123/self_hosted_search");
    assert.match(results[0].snippet, /Community experience/);
    assert.equal(results[1].provider, "searxng-reddit");
    assert.equal(results[1].rank, 4);
    assert.equal(results[1].url, "https://redd.it/def456");
    assert.equal(results[2].provider, "searxng-reddit");
    assert.equal(results[2].rank, 5);
    assert.equal(results[2].url, "https://old.reddit.com./r/selfhosted/comments/ghi789/another_post");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.SEARXNG_URL; else process.env.SEARXNG_URL = previousUrl;
  }
});

test("SearXNG Reddit-query failures preserve upstream HTTP statuses", async () => {
  const previousFetch = globalThis.fetch;
  const previousUrl = process.env.SEARXNG_URL;
  process.env.SEARXNG_URL = "http://searxng:8080";
  try {
    for (const status of [403, 404]) {
      resetSearchProviderReliability();
      globalThis.fetch = async () => new Response("upstream failure", { status, headers: { "content-type": "application/json" } });
      await assert.rejects(
        searchSearXNGReddit({ query: "weather cup", focus: "community", count: 5, queryIndex: 0, intent: "community" }),
        new RegExp(`HTTP ${status}`),
      );
    }
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.SEARXNG_URL; else process.env.SEARXNG_URL = previousUrl;
  }
});

test("Wikipedia search targets only the Wikipedia SearXNG engine", async () => {
  const previousFetch = globalThis.fetch;
  const previousUrl = process.env.SEARXNG_URL;
  process.env.SEARXNG_URL = "http://searxng:8080";
  resetSearchProviderReliability();
  let requestedQuery = "";
  let requestedEngines = "";
  globalThis.fetch = async (_url, init = {}) => {
    const body = new URLSearchParams(init.body);
    requestedQuery = body.get("q") ?? "";
    requestedEngines = body.get("engines") ?? "";
    return Response.json({ results: [{ title: "Reference", url: "https://en.wikipedia.org/wiki/Reference", content: "Reference evidence" }] });
  };
  try {
    const results = await searchSearXNGWikipedia({ query: "TypeScript", focus: "reference", count: 5, queryIndex: 0, intent: "reference" });
    assert.equal(requestedQuery, "TypeScript");
    assert.equal(requestedEngines, "wikipedia");
    assert.equal(results[0].provider, "searxng");
    assert.equal(results[0].url, "https://en.wikipedia.org/wiki/Reference");
  } finally {
    globalThis.fetch = previousFetch;
    resetSearchProviderReliability();
    if (previousUrl === undefined) delete process.env.SEARXNG_URL; else process.env.SEARXNG_URL = previousUrl;
  }
});

test("Firecrawl page retrieval requests Markdown only and preserves discovered links", async () => {
  const previousFetch = globalThis.fetch;
  const previousUrl = process.env.FIRECRAWL_URL;
  const calls = [];
  process.env.FIRECRAWL_URL = "http://firecrawl:3002";
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return Response.json({
      success: true,
      data: {
        markdown: `# Retrieved page\n\n${"Evidence ".repeat(40)}\n\n[Related page](https://example.com/related)`,
        metadata: { title: "Retrieved page", sourceURL: "https://example.com/source" },
      },
    });
  };
  try {
    const page = await extractFirecrawl("https://example.com/page");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://firecrawl:3002/v2/scrape");
    assert.deepEqual(calls[0].body.formats, ["markdown"]);
    assert.equal(calls[0].body.url, "https://example.com/page");
    assert.equal(page.extractor, "firecrawl");
    assert.equal(page.title, "Retrieved page");
    assert.deepEqual(page.links, [{ url: "https://example.com/related", text: "Related page" }]);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.FIRECRAWL_URL; else process.env.FIRECRAWL_URL = previousUrl;
  }
});

test("page retrieval falls back to bounded direct HTML extraction when Firecrawl is unavailable", async () => {
  const previousFetch = globalThis.fetch;
  const previousUrl = process.env.FIRECRAWL_URL;
  process.env.FIRECRAWL_URL = "http://firecrawl:3002";
  globalThis.fetch = async (url) => {
    if (String(url).includes("firecrawl")) throw new Error("connection refused");
    return new Response('<html><head><title>Fallback article</title></head><body><article>' + "Evidence ".repeat(60) + '</article><a href="https://example.com/related">Related</a></body></html>', { headers: { "content-type": "text/html" } });
  };
  try {
    const page = await extractFirecrawl("https://example.com/article");
    assert.equal(page.extractor, "direct-readability-fallback");
    assert.equal(page.title, "Fallback article");
    assert.match(page.markdown, /Evidence/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.FIRECRAWL_URL; else process.env.FIRECRAWL_URL = previousUrl;
  }
});

test("news searches use the SearXNG news category and latest feed entries for broad queries", async () => {
  const previousFetch = globalThis.fetch;
  const previousSearXNGUrl = process.env.SEARXNG_URL;
  const previousMinifluxUrl = process.env.MINIFLUX_URL;
  const calls = [];
  process.env.SEARXNG_URL = "http://searxng:8080";
  process.env.MINIFLUX_URL = "http://miniflux:8080";
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("searxng")) return Response.json({ results: [{ title: "Headline", url: "https://example.com/news", content: "Current news" }] });
    return Response.json({ entries: [{ title: "Feed headline", url: "https://example.com/feed", content: "Latest feed item", published_at: "2026-08-04T12:00:00Z" }] });
  };
  try {
    const query = { query: "top news today", focus: "news", count: 10, queryIndex: 0, intent: "recent", freshness: "day" };
    await searchSearXNG(query);
    await searchMiniflux(query);
    assert.equal(calls[0].url, "http://searxng:8080/search");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.headers.Accept, "application/json");
    assert.equal(calls[0].init.headers["Content-Type"], "application/x-www-form-urlencoded");
    assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0].init.body)), {
      q: "top news today",
      format: "json",
      categories: "news",
      pageno: "1",
      time_range: "day",
    });
    assert.equal(calls[1].url.startsWith("http://miniflux:8080/v1/entries?"), true);
    assert.doesNotMatch(calls[1].url, /search=/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousSearXNGUrl === undefined) delete process.env.SEARXNG_URL; else process.env.SEARXNG_URL = previousSearXNGUrl;
    if (previousMinifluxUrl === undefined) delete process.env.MINIFLUX_URL; else process.env.MINIFLUX_URL = previousMinifluxUrl;
  }
});

test("SearXNG rejects a successful HTML page instead of parsing the UI", async () => {
  const previousFetch = globalThis.fetch;
  const previousUrl = process.env.SEARXNG_URL;
  process.env.SEARXNG_URL = "http://searxng:8080";
  globalThis.fetch = async () => new Response("<html><body>Search UI</body></html>", {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
  try {
    await assert.rejects(
      searchSearXNG({ query: "weather cup", focus: "general", count: 5, queryIndex: 0, intent: "general" }),
      /non-json/i,
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.SEARXNG_URL; else process.env.SEARXNG_URL = previousUrl;
  }
});

test("general search does not return irrelevant Wikipedia results", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes("searxng")) return Response.json({ results: [] });
    return Response.json({ entries: [] });
  };
  try {
    await assert.rejects(
      searchSelfHosted({ query: "Pokémon Weather Cup Magcargo", focus: "general", count: 10 }),
      (error) => error instanceof SearchNoResultsError && /no relevant search results/i.test(error.message),
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("news search returns healthy Miniflux results when SearXNG is unavailable", async () => {
  const previousFetch = globalThis.fetch;
  resetSearchProviderReliability();
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes("searxng")) throw new Error("connection refused");
    return Response.json({ entries: [{ title: "Weather Cup guide", url: "https://example.com/weather-cup", content: "Magcargo matchup evidence" }] });
  };
  try {
    const results = await searchSelfHosted({ query: "Pokémon Weather Cup Magcargo", focus: "news", count: 10 });
    assert.equal(results.length, 1);
    assert.equal(results[0].provider, "miniflux");
  } finally {
    globalThis.fetch = previousFetch;
    resetSearchProviderReliability();
  }
});

test("search reports rejected provider names when no provider has usable results", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("connection refused"); };
  try {
    await assert.rejects(
      searchSelfHosted({ query: "weather cup", focus: "news", count: 10 }),
      (error) => error instanceof SearchUnavailableError
        && /searxng/.test(error.message)
        && /miniflux/.test(error.message),
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("Miniflux search prefers an API token and supports deployment Basic auth fallback", async () => {
  const previousFetch = globalThis.fetch;
  const previous = {
    token: process.env.MINIFLUX_API_TOKEN,
    username: process.env.MINIFLUX_ADMIN_USERNAME,
    password: process.env.MINIFLUX_ADMIN_PASSWORD,
  };
  delete process.env.MINIFLUX_API_TOKEN;
  process.env.MINIFLUX_ADMIN_USERNAME = "admin";
  process.env.MINIFLUX_ADMIN_PASSWORD = "secret";
  let headers;
  globalThis.fetch = async (_url, init) => {
    headers = init.headers;
    return Response.json({ entries: [] });
  };
  try {
    await searchMiniflux({ query: "latest news", focus: "news", count: 5, queryIndex: 0, intent: "recent" });
    assert.equal(headers.Authorization, `Basic ${Buffer.from("admin:secret").toString("base64")}`);
    process.env.MINIFLUX_API_TOKEN = "token-preferred";
    await searchMiniflux({ query: "latest news", focus: "news", count: 5, queryIndex: 0, intent: "recent" });
    assert.equal(headers["X-Auth-Token"], "token-preferred");
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries({ MINIFLUX_API_TOKEN: previous.token, MINIFLUX_ADMIN_USERNAME: previous.username, MINIFLUX_ADMIN_PASSWORD: previous.password })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
