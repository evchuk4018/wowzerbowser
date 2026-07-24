import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildDeepSeekMessages } from "../app/providers/deepseek/deepseek-messages.ts";
import { latestNonNullUsage, sumRoundUsage } from "../app/chat/chat-usage.ts";
import { toChatMessageInput } from "../app/chat/chat-message-input.ts";
import {
  boundedPythonTimeoutMs,
  waitForPythonDeadline,
} from "../lib/python-execution-deadlines.ts";
import {
  relativeWorkspacePath,
  validatePythonToolInput,
  PYTHON_TOOL_INPUT_LIMITS,
} from "../lib/python-tool-policy.ts";
import {
  RUN_PYTHON_INSTRUCTIONS,
  runPythonInstructionsFor,
} from "../app/server/agent/python-tool-instructions.ts";
import { configuredKeys, withProviderKeys } from "../app/server/agent/web-api-key-pool.ts";
import {
  availableWebTools,
  CHECK_DATE_TOOL_NAME,
  CHECK_LOCATION_TOOL_NAME,
  CHECK_TIME_TOOL_NAME,
  executeWebTool,
  WEB_TOOL_DEFINITIONS,
} from "../app/server/agent/web-tools.ts";
import { parseChatRequest } from "../lib/chat-protocol.ts";

function request(overrides = {}) {
  return {
    systemPrompt: "system context",
    userPresence: "user presence",
    model: "deepseek-v4-flash",
    thinking: true,
    reasoningEffort: "high",
    messages: [{ role: "user", content: "Calculate this" }],
    ...overrides,
  };
}

test("buildDeepSeekMessages orders conditional tool instructions and replays rounds", () => {
  const result = buildDeepSeekMessages(
    request({
      messages: [
        { role: "user", content: "Calculate this" },
        {
          role: "assistant",
          content: "Done",
          rounds: [
            {
              reasoning: "I should calculate.",
              content: "",
              toolCalls: [
                {
                  id: "call-1",
                  name: "run_python",
                  arguments: '{"code":"print(42)"}',
                  result: {
                    id: "call-1",
                    name: "run_python",
                    ok: true,
                    stdout: "42\n",
                    stderr: "",
                  },
                },
              ],
            },
          ],
        },
      ],
    }),
    {
      systemInstructions: [RUN_PYTHON_INSTRUCTIONS],
      replayRounds: [{ content: "The answer is 42.", toolCalls: [] }],
    },
  );

  assert.deepEqual(
    result.slice(0, 3),
    [
      { role: "system", content: "system context" },
      { role: "system", content: "user presence" },
      { role: "system", content: RUN_PYTHON_INSTRUCTIONS },
    ],
  );
  assert.deepEqual(result[3], { role: "user", content: "Calculate this" });
  assert.equal(result[4].role, "assistant");
  assert.equal(result[4].content, null);
  assert.equal(result[4].reasoning_content, "I should calculate.");
  assert.equal(result[4].tool_calls?.[0]?.function.name, "run_python");
  assert.equal(result[5].role, "tool");
  assert.match(result[5].content, /"stdout":"42\\n"/);
  assert.deepEqual(result[6], { role: "assistant", content: "The answer is 42." });
});

test("run_python instructions are absent unless the tool is advertised", () => {
  assert.deepEqual(runPythonInstructionsFor(false), []);
  assert.deepEqual(runPythonInstructionsFor(true), [RUN_PYTHON_INSTRUCTIONS]);
  assert.match(RUN_PYTHON_INSTRUCTIONS, /exactly one.*code.*file/i);
  assert.match(RUN_PYTHON_INSTRUCTIONS, /packages.*20/i);
  assert.match(RUN_PYTHON_INSTRUCTIONS, /args.*32/i);
  assert.match(RUN_PYTHON_INSTRUCTIONS, /artifacts.*20/i);
  assert.match(RUN_PYTHON_INSTRUCTIONS, /six \(6\) run_python calls/i);
  assert.match(RUN_PYTHON_INSTRUCTIONS, /ok.*stdout.*stderr.*exitCode.*artifacts/i);
});

test("run_python manifest uses the shared input limits", async () => {
  const source = await readFile(new URL("../app/server/agent/python-tool-manifest.ts", import.meta.url), "utf8");
  assert.match(source, /maxItems:\s*PYTHON_TOOL_INPUT_LIMITS\.maxPackages/);
  assert.match(source, /maxItems:\s*PYTHON_TOOL_INPUT_LIMITS\.maxArgs/);
  assert.match(source, /maxItems:\s*PYTHON_TOOL_INPUT_LIMITS\.maxArtifacts/);
  assert.match(source, /PYTHON_TOOL_INPUT_LIMITS/);
});

test("web tools have bounded manifests, configuration gates, and opaque key rotation", async () => {
  assert.deepEqual(WEB_TOOL_DEFINITIONS.map((tool) => tool.function.name), ["web_search", "fetch_page", "check_time", "check_date", "check_location"]);
  assert.equal(WEB_TOOL_DEFINITIONS[0].function.parameters.properties.count.maximum, 5);
  assert.equal(WEB_TOOL_DEFINITIONS[1].function.parameters.properties.url.maxLength, 2_000);
  assert.equal(WEB_TOOL_DEFINITIONS[2].function.parameters.properties.timeZone.maxLength, 100);
  assert.deepEqual(WEB_TOOL_DEFINITIONS[4].function.parameters.properties, {});
  const original = { brave: process.env.BRAVE_API_KEYS, exa: process.env.EXA_API_KEYS, location: process.env.DEPLOYMENT_LOCATION };
  delete process.env.BRAVE_API_KEYS; delete process.env.EXA_API_KEYS; delete process.env.DEPLOYMENT_LOCATION;
  assert.deepEqual(availableWebTools().map((tool) => tool.function.name), [CHECK_TIME_TOOL_NAME, CHECK_DATE_TOOL_NAME]);
  process.env.DEPLOYMENT_LOCATION = "Amsterdam, Netherlands";
  assert.deepEqual(availableWebTools().map((tool) => tool.function.name), [CHECK_TIME_TOOL_NAME, CHECK_DATE_TOOL_NAME, CHECK_LOCATION_TOOL_NAME]);
  process.env.BRAVE_API_KEYS = " first,\nsecond ";
  assert.deepEqual(configuredKeys("brave"), ["first", "second"]);
  const used = [];
  const result = await withProviderKeys(configuredKeys("brave"), async (key) => { used.push(key); if (key === "first") throw new Response("no", { status: 429 }); return { content: "safe" }; });
  assert.deepEqual(used, ["first", "second"]);
  assert.deepEqual(result, { content: "safe" });
  assert.doesNotMatch(JSON.stringify(result), /first|second|retry|failover/i);
  for (const [name, value] of Object.entries({ BRAVE_API_KEYS: original.brave, EXA_API_KEYS: original.exa, DEPLOYMENT_LOCATION: original.location })) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

test("time, date, and location tools validate inputs and produce bounded structured results", async () => {
  const time = await executeWebTool({ id: "time-1", name: CHECK_TIME_TOOL_NAME, arguments: '{"timeZone":"America/New_York"}' });
  assert.equal(time.ok, true);
  assert.equal(time.utility?.kind, "time");
  assert.equal(time.utility?.timeZone, "America/New_York");
  assert.match(time.utility?.currentTime ?? "", /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  const date = await executeWebTool({ id: "date-1", name: CHECK_DATE_TOOL_NAME, arguments: '{"timeZone":"Etc/UTC"}' });
  assert.deepEqual(date.utility, { kind: "date", currentDate: new Date().toISOString().slice(0, 10), timeZone: "UTC" });
  const invalid = await executeWebTool({ id: "time-2", name: CHECK_TIME_TOOL_NAME, arguments: '{"timeZone":"Not/A_Zone"}' });
  assert.equal(invalid.ok, false);
  assert.match(invalid.stderr, /invalid iana time zone/i);
  const original = process.env.DEPLOYMENT_LOCATION;
  delete process.env.DEPLOYMENT_LOCATION;
  const unavailable = await executeWebTool({ id: "location-1", name: CHECK_LOCATION_TOOL_NAME, arguments: "{}" });
  assert.deepEqual(unavailable.utility, { kind: "location", available: false, message: "Deployment location is not configured." });
  process.env.DEPLOYMENT_LOCATION = "Paris, France";
  const location = await executeWebTool({ id: "location-2", name: CHECK_LOCATION_TOOL_NAME, arguments: "{}" });
  assert.deepEqual(location.utility, { kind: "location", available: true, location: "Paris, France", source: "deployment_metadata" });
  const rejected = await executeWebTool({ id: "location-3", name: CHECK_LOCATION_TOOL_NAME, arguments: '{"url":"https://example.com"}' });
  assert.equal(rejected.ok, false);
  if (original === undefined) delete process.env.DEPLOYMENT_LOCATION; else process.env.DEPLOYMENT_LOCATION = original;
});

test("web search accepts the provider-compatible q argument alias", async () => {
  const originalFetch = globalThis.fetch;
  const originalKeys = process.env.BRAVE_API_KEYS;
  process.env.BRAVE_API_KEYS = "test-key";
  let requestedUrl = "";
  globalThis.fetch = async (url) => {
    requestedUrl = String(url);
    return Response.json({ web: { results: [] } });
  };
  try {
    const result = await executeWebTool({ id: "search-1", name: "web_search", arguments: '{"q":"current date"}' });
    assert.equal(result.ok, true);
    assert.equal(result.web?.kind, "search");
    assert.equal(result.web?.query, "current date");
    assert.equal(new URL(requestedUrl).searchParams.get("q"), "current date");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKeys === undefined) delete process.env.BRAVE_API_KEYS; else process.env.BRAVE_API_KEYS = originalKeys;
  }
});

test("web and utility tool results replay in the provider transcript", () => {
  const messages = buildDeepSeekMessages(request(), { replayRounds: [{ content: "", toolCalls: [{ id: "web-1", name: "web_search", arguments: '{"query":"today"}', result: { id: "web-1", name: "web_search", ok: true, stdout: "", stderr: "", web: { kind: "search", query: "today", results: [{ title: "Result", url: "https://example.com", snippet: "Snippet" }] } } }, { id: "date-1", name: CHECK_DATE_TOOL_NAME, arguments: "{}", result: { id: "date-1", name: CHECK_DATE_TOOL_NAME, ok: true, stdout: "", stderr: "", utility: { kind: "date", currentDate: "2026-07-24", timeZone: "UTC" } } }] }] });
  assert.equal(messages.at(-2)?.role, "assistant");
  assert.match(messages.at(-2)?.tool_calls?.[1]?.function.name ?? "", /check_date/);
  assert.match(messages.at(-1)?.content ?? "", /"query":"today"/);
  assert.match(messages.at(-1)?.content ?? "", /"currentDate":"2026-07-24"/);
  const replay = parseChatRequest(request({ messages: [{ role: "assistant", content: "", rounds: [{ content: "", toolCalls: [{ id: "date-1", name: CHECK_DATE_TOOL_NAME, arguments: "{}", result: { id: "date-1", name: CHECK_DATE_TOOL_NAME, ok: true, stdout: "", stderr: "", utility: { kind: "date", currentDate: "2026-07-24", timeZone: "UTC" } } }] }] }] }));
  assert.deepEqual(replay.messages[0].rounds?.[0]?.toolCalls?.[0]?.result?.utility, { kind: "date", currentDate: "2026-07-24", timeZone: "UTC" });
});

test("Python policy accepts shared maxima and rejects the next value", () => {
  const accepted = validatePythonToolInput({
    code: "print(1)",
    packages: Array.from({ length: PYTHON_TOOL_INPUT_LIMITS.maxPackages }, (_, index) => `pkg${index}`),
    args: Array.from({ length: PYTHON_TOOL_INPUT_LIMITS.maxArgs }, (_, index) => String(index)),
    artifacts: Array.from(
      { length: PYTHON_TOOL_INPUT_LIMITS.maxArtifacts },
      (_, index) => `outputs/result-${index}.txt`,
    ),
  });
  assert.equal(accepted.packages?.length, 20);
  assert.equal(accepted.args?.length, 32);
  assert.equal(accepted.artifacts?.length, 20);

  assert.throws(
    () => validatePythonToolInput({ code: "print(1)", packages: Array(21).fill("numpy") }),
    /at most 20/i,
  );
  assert.throws(
    () => validatePythonToolInput({ code: "print(1)", args: Array(33).fill("x") }),
    /at most 32/i,
  );
  assert.throws(
    () => validatePythonToolInput({ code: "print(1)", artifacts: Array(21).fill("out.txt") }),
    /at most 20/i,
  );
  assert.throws(
    () => validatePythonToolInput({ code: "print(1)", artifacts: [123] }),
    /string paths/i,
  );
  assert.throws(
    () => validatePythonToolInput({ code: "print(1)", unexpected: true }),
    /unexpected run_python argument/i,
  );
  assert.throws(
    () => validatePythonToolInput({ code: "print(1)", file: "script.py" }),
    /exactly one/i,
  );
  assert.throws(() => validatePythonToolInput({ packages: ["numpy"] }), /exactly one/i);
});

test("Python policy keeps workspace paths relative and rejects traversal", () => {
  assert.equal(relativeWorkspacePath("./outputs\\report.csv"), "outputs/report.csv");
  for (const unsafe of ["../report.csv", "outputs/../report.csv", "/tmp/report.csv", ".venv/bin/python", ".runs/log.txt", "C:\\tmp\\x.py"]) {
    assert.throws(() => relativeWorkspacePath(unsafe), /safe relative|reserved/i, unsafe);
  }
});

test("Python subprocess timeout is capped by call and response deadlines", () => {
  assert.equal(boundedPythonTimeoutMs(90_000, 200_000, 100_000), 60_000);
  assert.equal(boundedPythonTimeoutMs(10_000, 105_000, 100_000), 5_000);
  assert.equal(boundedPythonTimeoutMs(60_000, 151_243, 100_000), 51_000);
  assert.equal(boundedPythonTimeoutMs(10_000, 100_999, 100_000), 0);
  assert.equal(boundedPythonTimeoutMs(10_000, 100_000, 100_000), 0);
});

test("remote Python operations honor the same absolute deadline", async () => {
  assert.equal(
    await waitForPythonDeadline(Promise.resolve("ready"), Date.now() + 100, "late"),
    "ready",
  );
  await assert.rejects(
    waitForPythonDeadline(new Promise(() => undefined), Date.now() + 5, "deadline reached"),
    /deadline reached/,
  );
});

test("artifact reads are atomic, no-follow, and bounded before streaming", async () => {
  const source = await readFile(new URL("../app/server/modal/modal-python-executor.ts", import.meta.url), "utf8");
  assert.match(source, /O_NOFOLLOW/);
  assert.match(source, /os\.fstat\(fd\)/);
  assert.match(source, /PYTHON_TOOL_LIMITS\.maxArtifactBytes \+ 1/);
  assert.match(source, /readBoundedArtifactBytes/);
  assert.doesNotMatch(source, /filesystem\.readBytes/);
});

test("chat orchestration reserves one usage slot per round", async () => {
  const source = await readFile(new URL("../app/chat/chat-server-service.ts", import.meta.url), "utf8");
  assert.match(source, /const roundUsageIndex = roundUsages\.push\(null\) - 1/);
  assert.match(source, /roundUsages\[roundUsageIndex\] = latestNonNullUsage/);
  assert.doesNotMatch(source, /roundUsages\.push\(roundUsage\)/);
  assert.match(source, /new ModalPythonExecutor\(ownerId, conversationId, responseDeadlineAt\)/);
});

test("usage keeps the last snapshot within a round and sums finalized rounds once", () => {
  let roundOne = null;
  roundOne = latestNonNullUsage(roundOne, { promptTokens: 10, completionTokens: 2, totalTokens: 12 });
  roundOne = latestNonNullUsage(roundOne, null);
  roundOne = latestNonNullUsage(roundOne, { promptTokens: 11, completionTokens: 3, totalTokens: 14 });

  let roundTwo = null;
  roundTwo = latestNonNullUsage(roundTwo, { promptTokens: 7, completionTokens: 4, totalTokens: 11 });
  roundTwo = latestNonNullUsage(roundTwo, { promptTokens: 8, completionTokens: 5, totalTokens: 13 });

  assert.deepEqual(sumRoundUsage([roundOne, roundTwo]), {
    promptTokens: 19,
    completionTokens: 8,
    totalTokens: 27,
  });
  assert.deepEqual(sumRoundUsage([null, undefined]), null);
});

test("transcript mapper replays tool-only rounds and appends final content", () => {
  const mapped = toChatMessageInput({
    role: "assistant",
    content: "The answer is 42.",
    activities: [
      {
        id: "call-1",
        kind: "python",
        round: 1,
        call: { id: "call-1", name: "run_python", arguments: '{"code":"print(42)"}' },
        result: { id: "call-1", name: "run_python", ok: true, stdout: "42\n", stderr: "" },
        status: "completed",
      },
    ],
  });

  assert.equal(mapped?.rounds?.length, 2);
  assert.equal(mapped?.rounds?.[0]?.toolCalls?.[0]?.result?.stdout, "42\n");
  assert.equal(mapped?.rounds?.[1]?.content, "The answer is 42.");
});

test("transcript mapper attaches reasoning to a final non-tool round", () => {
  const mapped = toChatMessageInput({
    role: "assistant",
    content: "No execution was needed.",
    activities: [
      {
        id: "reasoning-1",
        kind: "reasoning",
        round: 1,
        content: "I can answer directly.",
        status: "complete",
      },
    ],
  });

  assert.deepEqual(mapped?.rounds, [{ content: "No execution was needed.", reasoning: "I can answer directly." }]);
});

test("transcript mapper preserves multiple calls and synthesizes interrupted results", () => {
  const mapped = toChatMessageInput({
    role: "assistant",
    content: "I could not finish both calls.",
    activities: [
      {
        id: "call-1",
        kind: "python",
        round: 1,
        call: { id: "call-1", name: "run_python", arguments: '{"code":"print(1)"}' },
        result: { id: "call-1", name: "run_python", ok: true, stdout: "1\n", stderr: "" },
        status: "completed",
      },
      {
        id: "call-2",
        kind: "python",
        round: 1,
        call: { id: "call-2", name: "run_python", arguments: '{"code":"print(2)"}' },
        status: "running",
      },
    ],
  });

  assert.equal(mapped?.rounds?.[0]?.toolCalls?.length, 2);
  assert.equal(mapped?.rounds?.[0]?.toolCalls?.[1]?.result?.ok, false);
  assert.match(mapped?.rounds?.[0]?.toolCalls?.[1]?.result?.stderr ?? "", /interrupted/i);
  assert.equal(mapped?.rounds?.[1]?.content, "I could not finish both calls.");
});
