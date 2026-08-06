import test from "node:test";
import assert from "node:assert/strict";
import { rankResearchCandidates } from "../app/server/research/research-ranking.ts";
import { availableDeepResearchTools, DEEP_RESEARCH_TOOL_DEFINITIONS } from "../app/server/agent/deep-research-tool-manifest.ts";
import { executeDeepResearchTool } from "../app/server/agent/deep-research-tool.ts";
import { assertPublicResearchUrl } from "../app/providers/research/research-page-adapters.ts";
import { searchSelfHosted } from "../app/server/search/search-service.ts";
import { runSubagents } from "../app/server/agent/subagent-coordinator.ts";
import { ResearchTraceCoordinator } from "../app/server/research/deep-research-service.ts";

const source = (overrides = {}) => ({
  id: `src_${String(overrides.rank ?? 1).padStart(16, "0")}`,
  title: "Result",
  url: "https://example.com/result",
  snippet: "Evidence",
  publisher: "example.com",
  provider: "searxng",
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

test("independent self-hosted searches query all providers concurrently", async () => {
  const previousFetch = globalThis.fetch;
  let active = 0;
  let maximum = 0;
  globalThis.fetch = async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
    return Response.json({ results: [{ title: "Result", url: "https://example.com/result", content: "Evidence" }] });
  };
  try {
    await Promise.all([
      searchSelfHosted({ query: "one", focus: "reference", queryIndex: 0, intent: "official" }),
      searchSelfHosted({ query: "two", focus: "general", queryIndex: 1, intent: "analysis" }),
    ]);
    assert.equal(maximum, 8);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("self-hosted search focus preserves the unified provider contract", async () => {
  const previousFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(new URL(String(url)));
    return Response.json({ results: [{ title: "Result", url: "https://example.com/result", content: "Evidence" }] });
  };
  try {
    const results = await searchSelfHosted({ query: "page", focus: "community" });
    assert.equal(results.length, 1);
    assert.equal(new Set(requested.map((url) => url.hostname)).size, 4);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("subagent coordinator queues every task before concurrent workers and returns ordered terminal results", async () => {
  const tasks = [
    { id: "one", title: "One", prompt: "one" },
    { id: "two", title: "Two", prompt: "two" },
    { id: "three", title: "Three", prompt: "three" },
  ];
  const updates = [];
  const started = [];
  const results = await runSubagents({
    tasks,
    concurrency: 2,
    onUpdate: (update) => updates.push(update),
    worker: async (task) => {
      started.push(task.id);
      await new Promise((resolve) => setTimeout(resolve, task.id === "one" ? 25 : 1));
      if (task.id === "two") throw new Error("worker failed");
      return task.id.toUpperCase();
    },
  });

  assert.deepEqual(updates.slice(0, 3).map(({ status, task }) => [status, task.id]), [
    ["queued", "one"], ["queued", "two"], ["queued", "three"],
  ]);
  assert.deepEqual(started, ["one", "two", "three"]);
  assert.deepEqual(results.map((result) => [result.task.id, result.value, result.error]), [
    ["one", "ONE", undefined], ["two", undefined, "worker failed"], ["three", "THREE", undefined],
  ]);
  for (const task of tasks) {
    const taskUpdates = updates.filter((update) => update.task.id === task.id);
    assert.equal(taskUpdates[0].status, "queued");
    assert.ok(["completed", "failed"].includes(taskUpdates.at(-1).status));
  }
});

test("pre-aborted subagent runs still publish queued and terminal cancellation updates", async () => {
  const controller = new AbortController();
  controller.abort("cancelled");
  const updates = [];
  let workerCalls = 0;
  const tasks = [
    { id: "cancel-one", title: "One", prompt: "one" },
    { id: "cancel-two", title: "Two", prompt: "two" },
  ];
  const results = await runSubagents({
    tasks,
    signal: controller.signal,
    onUpdate: (update) => updates.push(update),
    worker: async () => {
      workerCalls += 1;
      return "unexpected";
    },
  });

  assert.equal(workerCalls, 0);
  assert.deepEqual(updates.map(({ status }) => status), ["queued", "queued", "failed", "failed"]);
  assert.deepEqual(results.map((result) => result.error), ["Subagent cancelled.", "Subagent cancelled."]);
});

test("research trace callbacks expose only bounded shared stage entries and never private reasoning", async () => {
  const updates = [];
  const coordinator = new ResearchTraceCoordinator({
    actorId: "actor/private",
    onUpdate: (update) => updates.push(update),
  });
  coordinator.appendReasoning("PRIVATE_REASONING_MUST_NOT_ESCAPE");
  await coordinator.update("query_planning", "started");
  await coordinator.update("searching", "completed", "completed");
  await coordinator.update("verification", "failed", "failed");
  coordinator.cancel();

  assert.equal(updates.length, 3);
  assert.deepEqual(updates.map((update) => update.trace[0].kind), ["stage", "stage", "stage"]);
  assert.deepEqual(updates.map((update) => update.trace[0].status), ["running", "completed", "failed"]);
  for (const update of updates) {
    assert.ok(update.trace[0].id.length <= 128);
    assert.ok(update.trace[0].label.length <= 512);
    assert.ok(!JSON.stringify(update).includes("PRIVATE_REASONING_MUST_NOT_ESCAPE"));
  }
});

test("research trace coordinator forwards bounded reasoning only through its explicit public sink", async () => {
  const updates = [];
  const reasoning = [];
  const coordinator = new ResearchTraceCoordinator({
    actorId: "orchestrator",
    onUpdate: (update) => updates.push(update),
    onReasoningDelta: (delta) => reasoning.push(delta),
  });

  await coordinator.appendReasoning("Visible orchestrator reasoning.");
  coordinator.cancel();

  assert.deepEqual(reasoning, ["Visible orchestrator reasoning."]);
  assert.deepEqual(updates, []);
});
