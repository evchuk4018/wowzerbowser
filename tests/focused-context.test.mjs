import assert from "node:assert/strict";
import test from "node:test";
import { compileFocusedContext } from "../app/server/chat/focused-context.ts";
import { executeCurrentChatContextTool } from "../app/server/agent/current-chat-context-tool.ts";
import { parseChatUserPreferences } from "../lib/chat-user-preferences.ts";
import { parseChatRequest } from "../lib/chat-protocol.ts";

const routerAnswer = (content) => ({
  content,
  model: "qwen/test-router",
  usage: { promptTokens: 10, completionTokens: 3, totalTokens: 13 },
  estimatedUsage: { promptTokens: 10, completionTokens: 3, totalTokens: 13 },
  exactCostUsd: 0.0001,
});

function turn(index, options = {}) {
  return [
    { role: "user", content: options.user ?? `User request ${index}` },
    {
      role: "assistant",
      content: options.assistant ?? `Assistant answer ${index}`,
      reasoning: `private reasoning ${index}`,
      rounds: [{
        content: "",
        reasoning: `private round reasoning ${index}`,
        toolCalls: options.toolResult ? [{
          id: `call-${index}`,
          name: "run_python",
          arguments: "{}",
          result: options.toolResult,
        }] : [],
      }],
    },
  ];
}

test("focused context keeps recent turns, selects relevant older turns, and strips historical traces", async () => {
  const messages = [
    ...turn(1, {
      user: "Create the quarterly artifact.",
      toolResult: {
        id: "call-1",
        name: "run_python",
        ok: true,
        stdout: "artifact saved; api_key=super-secret-value",
        stderr: "",
        artifacts: [{ id: "a1", name: "quarterly.pdf", contentType: "application/pdf", size: 12 }],
      },
    }),
    ...turn(2),
    ...turn(3),
    ...turn(4),
    ...turn(5),
    { role: "user", content: "Continue using the quarterly artifact." },
  ];
  const usages = [];
  const plan = await compileFocusedContext({
    messages,
    signal: new AbortController().signal,
    toolGroups: [
      { id: "web", summary: "Search current information.", keywords: ["latest"] },
      { id: "phase", summary: "Break phases.", keywords: [], required: true },
    ],
    router: async () => routerAnswer('{"turnIds":["turn-1"],"toolGroups":["web"]}'),
    onRouterUsage: async (usage) => usages.push(usage),
  });

  assert.deepEqual(plan.selectedTurnIds, ["turn-4", "turn-5", "turn-1"]);
  assert.equal(plan.omittedTurnCount, 2);
  assert.equal(plan.selectedToolGroups.has("phase"), true);
  assert.equal(plan.selectedToolGroups.has("web"), true);
  assert.equal(plan.routerUsed, true);
  assert.equal(plan.routerFallback, false);
  assert.equal(usages[0].estimated, false);
  const serialized = JSON.stringify(plan.messages);
  assert.doesNotMatch(serialized, /private reasoning|private round reasoning|toolCalls|rounds/);
  assert.doesNotMatch(serialized, /super-secret-value/);
  assert.doesNotMatch(serialized, /api_key/);
  assert.match(serialized, /quarterly artifact/);
  assert.match(serialized, /Assistant answer 5/);
  assert.ok(plan.afterCharacters < plan.beforeCharacters);
});

test("focused context preference is opt-in and durable requests default to full mode", () => {
  assert.equal(parseChatUserPreferences({ userPresence: "" }).focusedContextEnabled, false);
  assert.equal(parseChatUserPreferences({ userPresence: "", focusedContextEnabled: true }).focusedContextEnabled, true);
  const base = {
    systemPrompt: "ignored client prompt",
    userPresence: "",
    model: "deepseek-v4-flash",
    thinking: false,
    reasoningEffort: "high",
    messages: [{ role: "user", content: "Hello" }],
  };
  assert.equal(parseChatRequest(base).contextMode, "full");
  assert.equal(parseChatRequest({ ...base, contextMode: "focused" }).contextMode, "focused");
  assert.throws(() => parseChatRequest({ ...base, contextMode: "unknown" }), /contextMode is invalid/);
});

test("router failure uses conservative fallback groups and lexical turn recovery", async () => {
  const plan = await compileFocusedContext({
    messages: [
      ...turn(1, { user: "The deployment target is Toronto." }),
      ...turn(2),
      ...turn(3),
      { role: "user", content: "What was the deployment target?" },
    ],
    signal: new AbortController().signal,
    toolGroups: [
      { id: "web", summary: "Search the web.", keywords: ["latest"], fallback: true },
      { id: "image", summary: "Inspect an image.", keywords: ["image"] },
    ],
    router: async () => { throw new Error("router unavailable"); },
  });

  assert.equal(plan.routerFallback, true);
  assert.equal(plan.selectedToolGroups.has("web"), true);
  assert.equal(plan.selectedToolGroups.has("image"), false);
  assert.equal(plan.selectedTurnIds.includes("turn-1"), true);
});

test("current chat search returns compact tool facts without reasoning or secrets", () => {
  const result = executeCurrentChatContextTool({
    id: "search-1",
    name: "search_current_chat",
    arguments: '{"query":"quarterly artifact"}',
  }, [{
    id: "turn-1",
    position: 0,
    user: "Create the quarterly artifact.",
    assistant: "Done.",
    toolFacts: ["run_python: succeeded; output=artifact saved; api_key=[redacted]; artifacts=quarterly.pdf"],
  }]);

  assert.equal(result.ok, true);
  assert.match(result.stdout, /quarterly\.pdf/);
  assert.doesNotMatch(result.stdout, /super-secret|reasoning/);
});
