import assert from "node:assert/strict";
import test from "node:test";
import { extractFirecrawl } from "../app/providers/research/research-page-adapters.ts";
import { searchRedlib } from "../app/providers/search/redlib-search-adapter.ts";
import { searchMiniflux } from "../app/providers/search/miniflux-search-adapter.ts";
import { searchSearXNG } from "../app/providers/search/searxng-search-adapter.ts";

test("Redlib search normalizes discussion links to public Reddit URLs", async () => {
  const previousFetch = globalThis.fetch;
  const previousUrl = process.env.REDLIB_URL;
  process.env.REDLIB_URL = "http://redlib:8080";
  globalThis.fetch = async () => new Response(
    '<main><article><a href="/r/selfhosted/comments/abc123/self_hosted_search/">Self-hosted search</a><p>Community experience</p></article></main>',
    { headers: { "content-type": "text/html" } },
  );
  try {
    const results = await searchRedlib({ query: "self hosted search", focus: "community", count: 20, queryIndex: 0, intent: "community" });
    assert.equal(results.length, 1);
    assert.equal(results[0].provider, "redlib");
    assert.equal(results[0].url, "https://www.reddit.com/r/selfhosted/comments/abc123/self_hosted_search");
    assert.match(results[0].snippet, /Community experience/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.REDLIB_URL; else process.env.REDLIB_URL = previousUrl;
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
  const calls = [];
  process.env.SEARXNG_URL = "http://searxng:8080";
  process.env.MINIFLUX_URL = "http://miniflux:8080";
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes("searxng")) return Response.json({ results: [{ title: "Headline", url: "https://example.com/news", content: "Current news" }] });
    return Response.json({ entries: [{ title: "Feed headline", url: "https://example.com/feed", content: "Latest feed item", published_at: "2026-08-04T12:00:00Z" }] });
  };
  try {
    const query = { query: "top news today", focus: "news", count: 10, queryIndex: 0, intent: "recent" };
    await searchSearXNG(query);
    await searchMiniflux(query);
    assert.match(calls[0], /categories=news/);
    assert.match(calls[1], /\/v1\/entries\?/);
    assert.doesNotMatch(calls[1], /search=/);
  } finally {
    globalThis.fetch = previousFetch;
    delete process.env.SEARXNG_URL;
    delete process.env.MINIFLUX_URL;
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
