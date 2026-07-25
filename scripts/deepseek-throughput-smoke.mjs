import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { DEFAULT_CHAT_SYSTEM_PROMPT } from "../lib/chat-protocol.ts";

function loadDotEnv() {
  try {
    const text = fs.readFileSync(".env", "utf8");
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
      }
    }
  } catch {
    // Deployed smoke runs provide environment variables directly.
  }
}

loadDotEnv();

const MODEL = "deepseek-v4-flash";
const SYSTEM_PROMPT = DEFAULT_CHAT_SYSTEM_PROMPT;
const PROMPT = "Write exactly 100 words explaining why streaming responses feel fast.";
const SAMPLE_COUNT = Math.max(1, Number(process.env.SMOKE_SAMPLES ?? "5") || 5);

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the app-path smoke test.`);
  return value;
}

function completionTokens(usage) {
  if (typeof usage?.completion_tokens === "number") return usage.completion_tokens;
  if (typeof usage?.completionTokens === "number") return usage.completionTokens;
  return null;
}

function outputMetrics({ startedAt, firstOutputAt, lastOutputAt, usage }) {
  const tokens = completionTokens(usage);
  const outputWindowMs = firstOutputAt === null || lastOutputAt === null
    ? null
    : lastOutputAt - firstOutputAt;
  return {
    completionTokens: tokens,
    firstOutputLatencyMs: firstOutputAt === null
      ? null
      : Number((firstOutputAt - startedAt).toFixed(1)),
    outputWindowMs: outputWindowMs === null ? null : Number(outputWindowMs.toFixed(1)),
    outputTps: tokens !== null && outputWindowMs !== null && outputWindowMs > 0
      ? Number((tokens / (outputWindowMs / 1000)).toFixed(2))
      : null,
  };
}

function consumeProviderBlock(block, timing) {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n");
  if (!data || data === "[DONE]") return;
  let chunk;
  try {
    chunk = JSON.parse(data);
  } catch {
    return;
  }
  const delta = chunk.choices?.[0]?.delta;
  if (delta?.reasoning_content || delta?.content) {
    const now = performance.now();
    timing.firstOutputAt ??= now;
    timing.lastOutputAt = now;
  }
  if (chunk.usage) timing.usage = chunk.usage;
}

async function directProviderCall(thinking) {
  const startedAt = performance.now();
  const timing = { firstOutputAt: null, lastOutputAt: null, usage: null };
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${required("DEEPSEEK_API_KEY")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: PROMPT },
      ],
      thinking: { type: thinking ? "enabled" : "disabled" },
      ...(thinking ? { reasoning_effort: "high" } : {}),
      stream: true,
    }),
  });
  if (!response.ok || !response.body) {
    throw new Error(`Direct provider request failed (${response.status}).`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? "";
    for (const block of blocks) consumeProviderBlock(block, timing);
    if (done) break;
  }
  if (buffer.trim()) consumeProviderBlock(buffer, timing);
  return outputMetrics({ startedAt, ...timing });
}

function consumeAppBlock(block, timing) {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n");
  if (!data) return;
  let envelope;
  try {
    envelope = JSON.parse(data);
  } catch {
    return;
  }
  if (
    envelope.type === "event"
    && (envelope.event?.type === "reasoning" || envelope.event?.type === "content")
  ) {
    const now = performance.now();
    timing.firstOutputAt ??= now;
    timing.lastOutputAt = now;
  }
  if (envelope.type === "terminal") timing.terminal = envelope.terminal;
}

async function appPathCall(thinking) {
  const baseUrl = required("APP_SMOKE_BASE_URL").replace(/\/$/, "");
  const accessToken = required("APP_SMOKE_ACCESS_TOKEN");
  const conversationId = randomUUID();
  const jobId = randomUUID();
  const request = {
    systemPrompt: SYSTEM_PROMPT,
    userPresence: "",
    messages: [{ role: "user", content: PROMPT }],
    model: MODEL,
    thinking,
    reasoningEffort: "high",
    conversationId,
    jobId,
    idempotencyKey: jobId,
    persistence: {
      turnId: randomUUID(),
      versionId: randomUUID(),
      userMessageId: randomUUID(),
      assistantMessageId: randomUUID(),
      turnIndex: 0,
      versionIndex: 0,
    },
  };
  const headers = {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
  };
  const startedAt = performance.now();
  const timing = { firstOutputAt: null, lastOutputAt: null, terminal: null };

  try {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
    });
    if (!response.ok || !response.body) {
      throw new Error(`App request failed (${response.status}).`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) consumeAppBlock(block, timing);
      if (done) break;
    }
    if (buffer.trim()) consumeAppBlock(buffer, timing);
    if (timing.terminal?.status !== "completed") {
      throw new Error(`App job ended ${timing.terminal?.status ?? "without a terminal frame"}.`);
    }
    return {
      delivery: outputMetrics({
        startedAt,
        firstOutputAt: timing.firstOutputAt,
        lastOutputAt: timing.lastOutputAt,
        usage: timing.terminal.usage,
      }),
      provider: timing.terminal.providerMetrics,
    };
  } finally {
    await fetch(`${baseUrl}/api/chat/conversations/${encodeURIComponent(conversationId)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${accessToken}` },
    }).catch(() => undefined);
  }
}

function percentile(values, fraction) {
  const sorted = values.filter((value) => typeof value === "number").sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function summarize(samples, read) {
  const values = samples.map(read);
  return {
    median: percentile(values, 0.5),
    p95: percentile(values, 0.95),
  };
}

required("DEEPSEEK_API_KEY");
required("APP_SMOKE_BASE_URL");
required("APP_SMOKE_ACCESS_TOKEN");

const rows = [];
for (const thinking of [false, true]) {
  const samples = [];
  for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
    const direct = await directProviderCall(thinking);
    const app = await appPathCall(thinking);
    samples.push({ direct, app });
  }
  const directTps = summarize(samples, (sample) => sample.direct.outputTps);
  const providerTps = summarize(samples, (sample) => sample.app.provider?.outputTps);
  const deliveryTps = summarize(samples, (sample) => sample.app.delivery.outputTps);
  const deliveryRatios = samples.map((sample) => {
    const provider = sample.app.provider?.outputTps;
    const delivery = sample.app.delivery.outputTps;
    return provider && delivery ? delivery / provider : null;
  });
  const appTtft = summarize(samples, (sample) => sample.app.delivery.firstOutputLatencyMs);
  rows.push({
    thinking,
    samples: SAMPLE_COUNT,
    directMedianTps: directTps.median,
    directP95Tps: directTps.p95,
    appProviderMedianTps: providerTps.median,
    appProviderP95Tps: providerTps.p95,
    deliveryMedianTps: deliveryTps.median,
    deliveryP95Tps: deliveryTps.p95,
    deliveryProviderMedianRatio: summarize(deliveryRatios, (value) => value).median,
    appMedianTtftMs: appTtft.median,
    appP95TtftMs: appTtft.p95,
  });
}

console.table(rows);
console.log("Direct TPS is an upstream model baseline. The pass/fail threshold compares app provider-arrival TPS with browser-delivery TPS for the same app request.");
if (rows.some((row) => row.deliveryProviderMedianRatio === null || row.deliveryProviderMedianRatio < 0.9)) {
  process.exitCode = 1;
}
