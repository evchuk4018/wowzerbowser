import assert from "node:assert/strict";
import test from "node:test";
import { executeSubagentTool } from "../app/server/agent/subagent-tool.ts";
import {
  RUN_SUBAGENT_TOOL_DEFINITION,
  RUN_SUBAGENT_TOOL_NAME,
} from "../app/server/agent/subagent-tool-manifest.ts";
import { generateChatResponse } from "../app/chat/chat-server-service.ts";
import { planToolBatches, toolExecutionMetadata } from "../app/server/agent/tool-execution-policy.ts";
import { parseChatRequest } from "../lib/chat-protocol.ts";

const sse = (payload) => `data: ${JSON.stringify(payload)}\n\n`;

test("subagent manifest is an always-available single-task delegation tool", () => {
  assert.equal(RUN_SUBAGENT_TOOL_DEFINITION.function.name, RUN_SUBAGENT_TOOL_NAME);
  assert.match(RUN_SUBAGENT_TOOL_DEFINITION.function.description, /parallel/i);
  assert.deepEqual(RUN_SUBAGENT_TOOL_DEFINITION.function.parameters.required, ["task"]);
});

test("subagent executor validates input, forwards the task, and publishes lifecycle updates", async () => {
  const updates = [];
  const observedEvents = [];
  const result = await executeSubagentTool(
    { id: "subagent-call", name: RUN_SUBAGENT_TOOL_NAME, arguments: JSON.stringify({ task: "Inspect the repository", context: "Focus on the agent layer." }) },
    {
      signal: new AbortController().signal,
      onUpdate: async (update) => updates.push(update),
      run: async (request, onEvent) => {
        assert.equal(request.task, "Inspect the repository");
        assert.equal(request.context, "Focus on the agent layer.");
        await onEvent?.({ type: "tool_call", call: { id: "nested-call", name: "workspace_search", arguments: "{}" } });
        observedEvents.push(request.callId);
        return {
          ok: true,
          stdout: "Found the agent layer.",
          sources: [{ id: "src_0000000000000001", title: "Repository", url: "https://example.com/repo", snippet: "Evidence", publisher: "example.com" }],
        };
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.stdout, "Found the agent layer.");
  assert.equal(result.subagent?.kind, "delegation");
  assert.equal(result.subagent?.taskId, "subagent-call");
  assert.deepEqual(observedEvents, ["subagent-call"]);
  assert.deepEqual(updates.map(({ status }) => status), ["queued", "running", "running", "completed"]);
  assert.equal(updates[2].summary, "Using workspace_search.");
});

test("subagent calls batch in parallel while stateful workspace writes remain serial", () => {
  const batches = planToolBatches(
    [
      { name: RUN_SUBAGENT_TOOL_NAME },
      { name: RUN_SUBAGENT_TOOL_NAME },
      { name: "workspace_write" },
      { name: RUN_SUBAGENT_TOOL_NAME },
    ],
    ({ name }) => toolExecutionMetadata(name).executionPolicy,
  );
  assert.deepEqual(batches.map((batch) => batch.map(({ name }) => name)), [
    [RUN_SUBAGENT_TOOL_NAME, RUN_SUBAGENT_TOOL_NAME],
    ["workspace_write"],
    [RUN_SUBAGENT_TOOL_NAME],
  ]);
});

test("parallel subagent executions overlap and preserve result order", async () => {
  const { executeToolBatch } = await import("../app/server/agent/tool-execution-policy.ts");
  const release = [];
  let running = 0;
  let peak = 0;
  const batchPromise = executeToolBatch(
    ["one", "two"],
    async (name) => executeSubagentTool(
      { id: name, name: RUN_SUBAGENT_TOOL_NAME, arguments: JSON.stringify({ task: name }) },
      {
        signal: new AbortController().signal,
        run: async () => {
          running += 1;
          peak = Math.max(peak, running);
          await new Promise((resolve) => release.push(resolve));
          running -= 1;
          return { ok: true, stdout: `${name}-result` };
        },
      },
    ),
    new AbortController().signal,
    2,
  );
  // The executor starts both calls before either deferred child is released.
  await new Promise((resolve) => setImmediate(resolve));
  release.splice(0).forEach((resolve) => resolve());
  const settled = await batchPromise;
  assert.equal(peak, 2);
  assert.deepEqual(settled.map((item) => item.status), ["fulfilled", "fulfilled"]);
  assert.deepEqual(settled.map((item) => item.value.stdout), ["one-result", "two-result"]);
});

test("subagent results survive chat request replay validation with bounded sources", () => {
  const parsed = parseChatRequest({
    systemPrompt: "system",
    userPresence: "user",
    model: { provider: "deepseek", model: "deepseek-v4-flash" },
    thinking: false,
    reasoningEffort: "low",
    messages: [{
      role: "assistant",
      content: "delegation",
      rounds: [{
        content: "",
        toolCalls: [{
          id: "subagent-call",
          name: RUN_SUBAGENT_TOOL_NAME,
          arguments: JSON.stringify({ task: "Search" }),
          result: {
            id: "subagent-call",
            name: RUN_SUBAGENT_TOOL_NAME,
            ok: true,
            stdout: "Evidence",
            stderr: "",
            subagent: {
              kind: "delegation",
              taskId: "subagent-call",
              title: "Search",
              sources: [{ id: "ignored", title: "Source", url: "https://example.com/source", snippet: "Evidence", publisher: "example.com" }],
            },
          },
        }],
      }],
    }, { role: "user", content: "Continue." }],
  });
  const result = parsed.messages[0].rounds[0].toolCalls[0].result;
  assert.equal(result.subagent.kind, "delegation");
  assert.match(result.subagent.sources[0].id, /^src_[a-f0-9]{16}$/);
});

test("normal chat advertises subagents, child runs can use tools, and recursion is disabled", async () => {
  const originalFetch = globalThis.fetch;
  const originalDeepSeekKey = process.env.DEEPSEEK_API_KEY;
  const events = [];
  let providerRounds = 0;
  process.env.DEEPSEEK_API_KEY = "test-key";
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    providerRounds += 1;
    if (providerRounds === 1) {
      assert.ok(body.tools?.some((tool) => tool.function.name === RUN_SUBAGENT_TOOL_NAME));
      return new Response([
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "subagent-call", function: { name: RUN_SUBAGENT_TOOL_NAME, arguments: JSON.stringify({ task: "Search the codebase for the relevant implementation." }) } }] } }] }),
        sse({ choices: [{ delta: {} }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
        "data: [DONE]\n\n",
      ].join(""), { headers: { "content-type": "text/event-stream" } });
    }
    if (providerRounds === 2) {
      assert.equal(body.tools?.some((tool) => tool.function.name === RUN_SUBAGENT_TOOL_NAME), false);
      assert.match(body.messages.at(-1).content, /relevant implementation/);
      return new Response([
        sse({ choices: [{ delta: { content: "Child found the implementation." } }] }),
        "data: [DONE]\n\n",
      ].join(""), { headers: { "content-type": "text/event-stream" } });
    }
    assert.equal(providerRounds, 3);
    assert.ok(body.tools?.some((tool) => tool.function.name === RUN_SUBAGENT_TOOL_NAME));
    assert.match(JSON.stringify(body.messages), /Child found the implementation/);
    return new Response([
      sse({ choices: [{ delta: { content: "Parent synthesized the result." } }] }),
      "data: [DONE]\n\n",
    ].join(""), { headers: { "content-type": "text/event-stream" } });
  };

  try {
    await generateChatResponse(
      {
        systemPrompt: "system context",
        userPresence: "user presence",
        model: "deepseek-v4-flash",
        thinking: false,
        reasoningEffort: "low",
        contextMode: "full",
        messages: [{ role: "user", content: "Inspect the repository." }],
        conversationId: "subagent-conversation",
        jobId: "subagent-job",
      },
      "owner-1",
      new AbortController().signal,
      async (event) => events.push(event),
      async () => undefined,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDeepSeekKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalDeepSeekKey;
  }

  assert.equal(providerRounds, 3);
  assert.equal(events.find(({ type }) => type === "content")?.delta, "Parent synthesized the result.");
  assert.equal(events.find(({ type }) => type === "tool_result")?.result.stdout, "Child found the implementation.");
  const subagentStatuses = events.filter(({ type }) => type === "subagent_update").map(({ status }) => status);
  assert.equal(subagentStatuses[0], "queued");
  assert.equal(subagentStatuses[1], "running");
  assert.equal(subagentStatuses.at(-1), "completed");
});
