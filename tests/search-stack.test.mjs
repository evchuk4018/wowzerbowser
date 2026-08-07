import assert from "node:assert/strict";
import test from "node:test";
import { extractFirecrawl } from "../app/providers/research/research-page-adapters.ts";
import { searchMiniflux } from "../app/providers/search/miniflux-search-adapter.ts";
import { searchSearXNG, searchSearXNGReddit } from "../app/providers/search/searxng-search-adapter.ts";
import { SearchNoResultsError, SearchUnavailableError, searchSelfHosted } from "../app/server/search/search-service.ts";

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
      if (query === "self hosted search") return Response.json({ results: [] });
      if (query === "self hosted search reddit") return Response.json({ results: [
        { title: "Unrelated result", url: "https://example.com/not-reddit", content: "Should be filtered" },
        { title: "Self-hosted search", url: "https://www.reddit.com/r/selfhosted/comments/abc123/self_hosted_search/", content: "Community experience" },
        { title: "Suffix-confusion result", url: "https://reddit.com.evil.example/r/not-reddit", content: "Should be filtered" },
        { title: "Short Reddit link", url: "https://redd.it/def456", content: "Another Reddit result" },
        { title: "Trailing-dot Reddit link", url: "https://old.reddit.com./r/selfhosted/comments/ghi789/another_post", content: "A third Reddit result" },
      ] });
      throw new Error(`Unexpected SearXNG query: ${query}`);
    }
    if (value.includes("wikipedia")) return Response.json({ query: { pages: {} } });
    return Response.json({ entries: [] });
  };
  try {
    const results = await searchSelfHosted({ query: "self hosted search", focus: "community", count: 3, queryIndex: 0, intent: "community" });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map(({ query }) => query).sort(), ["self hosted search", "self hosted search reddit"]);
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
      globalThis.fetch = async () => new Response("upstream failure", { status, headers: { "content-type": "application/json" } });
      await assert.rejects(
        searchSearXNGReddit({ query: "weather cup", focus: "community", count: 5, queryIndex: 0, intent: "community" }),
        new RegExp(`status ${status}`),
      );
    }
  } finally {
    globalThis.fetch = previousFetch;
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

test("general search does not return irrelevant MediaWiki fallback pages", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes("searxng")) return Response.json({ results: [] });
    if (value.includes("wikipedia")) return Response.json({ query: { pages: {
      "1": { title: "Major League Soccer", fullurl: "https://en.wikipedia.org/wiki/Major_League_Soccer", extract: "The league is a professional soccer competition." },
      "2": { title: "FC Bayern Munich", fullurl: "https://en.wikipedia.org/wiki/FC_Bayern_Munich", extract: "A football club based in Munich." },
    } } });
    return Response.json({ entries: [] });
  };
  try {
    await assert.rejects(
      searchSelfHosted({ query: "Pokémon Weather Cup Magcargo", focus: "general", count: 10 }),
      (error) => error instanceof SearchNoResultsError && /no search results/i.test(error.message),
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("search returns healthy provider results when another provider is unavailable", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes("searxng")) return Response.json({ results: [{ title: "Weather Cup guide", url: "https://example.com/weather-cup", content: "Magcargo matchup evidence" }] });
    if (value.includes("wikipedia")) return Response.json({ query: { pages: {
      "1": { title: "Major League Soccer", fullurl: "https://en.wikipedia.org/wiki/Major_League_Soccer", extract: "The league is a professional soccer competition." },
    } } });
    return Response.json({ entries: [] });
  };
  try {
    const results = await searchSelfHosted({ query: "Pokémon Weather Cup Magcargo", focus: "general", count: 10 });
    assert.equal(results.length, 1);
    assert.equal(results[0].provider, "searxng");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("search reports rejected provider names when no provider has usable results", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("connection refused"); };
  try {
    await assert.rejects(
      searchSelfHosted({ query: "weather cup", focus: "general", count: 10 }),
      (error) => error instanceof SearchUnavailableError
        && /searxng/.test(error.message)
        && /searxng-reddit/.test(error.message)
        && /mediawiki/.test(error.message)
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
