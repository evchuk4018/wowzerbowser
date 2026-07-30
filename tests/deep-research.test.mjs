import test from "node:test";
import assert from "node:assert/strict";
import { rankResearchCandidates } from "../app/server/research/research-ranking.ts";
import { availableDeepResearchTools, DEEP_RESEARCH_TOOL_DEFINITIONS } from "../app/server/agent/deep-research-tool-manifest.ts";
import { executeDeepResearchTool } from "../app/server/agent/deep-research-tool.ts";
import { assertPublicResearchUrl } from "../app/providers/research/research-page-adapters.ts";
import { searchBrave } from "../app/providers/research/research-search-adapters.ts";

const source = (overrides = {}) => ({
  id: `src_${String(overrides.rank ?? 1).padStart(16, "0")}`,
  title: "Result",
  url: "https://example.com/result",
  snippet: "Evidence",
  publisher: "example.com",
  provider: "brave",
  queryIndex: 0,
  rank: 1,
  intent: "analysis",
  extraSnippets: [],
  ...overrides,
});

test("deep research manifests are one gated capability set", () => {
  assert.deepEqual(DEEP_RESEARCH_TOOL_DEFINITIONS.map((tool) => tool.function.name), [
    "deep_research_search", "find_in_page", "list_page_links", "follow_page_link",
  ]);
  const previous = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "configured";
  assert.equal(availableDeepResearchTools(false).length, 0);
  assert.equal(availableDeepResearchTools(true).length, 4);
  if (previous === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = previous;
});

test("research ranking fuses query coverage, primary sources, freshness, and duplicate URLs", () => {
  const ranked = rankResearchCandidates([
    source({ url: "https://agency.gov/report", queryIndex: 0, rank: 2, intent: "official" }),
    source({ url: "https://agency.gov/report#section", queryIndex: 1, rank: 1, intent: "recent", publishedAt: new Date().toISOString() }),
    source({ url: "https://example.com/opinion", queryIndex: 0, rank: 1 }),
  ]);
  assert.equal(ranked.length, 2);
  assert.match(ranked[0].url, /agency\.gov/);
  assert.ok(ranked[0].score > ranked[1].score);
});

test("navigation tools reject calls without a response-scoped active run", async () => {
  const executed = await executeDeepResearchTool(
    { id: "find-1", name: "find_in_page", arguments: '{"pageId":"page_x","query":"claim"}' },
    { ownerId: "owner", conversationId: "conversation", jobId: "job", activeRun: null },
  );
  assert.equal(executed.result.ok, false);
  assert.match(executed.result.stderr, /no active deep research run/i);
});

test("direct extraction rejects private and credential-bearing URLs before fetching", async () => {
  await assert.rejects(assertPublicResearchUrl("http://127.0.0.1/private"), /private/i);
  await assert.rejects(assertPublicResearchUrl("https://user:pass@example.com"), /public HTTP/i);
});

test("independent Brave searches can execute concurrently", async () => {
  const previousFetch = globalThis.fetch;
  const previousKeys = process.env.BRAVE_API_KEYS;
  process.env.BRAVE_API_KEYS = "key";
  let active = 0;
  let maximum = 0;
  globalThis.fetch = async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
    return Response.json({ web: { results: [] } });
  };
  try {
    await Promise.all([
      searchBrave({ query: "one", intent: "official" }, 0),
      searchBrave({ query: "two", intent: "analysis" }, 1),
    ]);
    assert.equal(maximum, 2);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKeys === undefined) delete process.env.BRAVE_API_KEYS; else process.env.BRAVE_API_KEYS = previousKeys;
  }
});

test("Brave pagination is bounded to the provider's supported page range", async () => {
  const previousFetch = globalThis.fetch;
  const previousKeys = process.env.BRAVE_API_KEYS;
  process.env.BRAVE_API_KEYS = "key";
  let requested;
  globalThis.fetch = async (url) => {
    requested = new URL(String(url));
    return Response.json({ web: { results: [] } });
  };
  try {
    await searchBrave({ query: "page", intent: "recent" }, 0, 99);
    assert.equal(requested.searchParams.get("offset"), "9");
    assert.equal(requested.searchParams.get("result_filter"), "web,news");
    assert.equal(requested.searchParams.get("extra_snippets"), "true");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKeys === undefined) delete process.env.BRAVE_API_KEYS; else process.env.BRAVE_API_KEYS = previousKeys;
  }
});
