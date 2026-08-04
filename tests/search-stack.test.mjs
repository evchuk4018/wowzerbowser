import assert from "node:assert/strict";
import test from "node:test";
import { extractFirecrawl } from "../app/providers/research/research-page-adapters.ts";
import { searchRedlib } from "../app/providers/search/redlib-search-adapter.ts";

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
