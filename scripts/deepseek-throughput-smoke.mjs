import fs from "node:fs";
import { randomUUID } from "node:crypto";

function loadDotEnv() {
  try {
    const text = fs.readFileSync(".env", "utf8");
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
    }
  } catch {
    // Deployed smoke runs provide environment variables directly.
  }
}

loadDotEnv();

const MODEL = "deepseek-v4-flash";
const PROMPT = "Write a concise 100-word paragraph explaining why streaming responses feel fast.";
const POLL_INTERVAL_MS = 100;

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the app-path smoke test.`);
  return value;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function metrics({ startedAt, firstOutputAt, lastOutputAt, usage }) {
  const firstOutputLatencyMs = firstOutputAt === null ? null : firstOutputAt - startedAt;
  const outputWindowMs = firstOutputAt === null || lastOutputAt === null ? null : lastOutputAt - firstOutputAt;
  const completionTokens = typeof usage?.completion_tokens === "number" ? usage.completion_tokens : null;
  return {
    completionTokens,
    firstOutputLatencyMs: firstOutputLatencyMs === null ? null : Number(firstOutputLatencyMs.toFixed(1)),
    outputTps: completionTokens !== null && outputWindowMs !== null && outputWindowMs > 0
      ? Number((completionTokens / (outputWindowMs / 1_000)).toFixed(2))
      : null,
    totalLatencyMs: Number(((lastOutputAt ?? performance.now()) - startedAt).toFixed(1)),
  };
}

async function directProviderCall(thinking) {
  const apiKey = required("DEEPSEEK_API_KEY");
  const startedAt = performance.now();
  let firstOutputAt = null;
  let lastOutputAt = null;
  let usage = null;
  let buffer = "";
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: PROMPT }],
      thinking: { type: thinking ? "enabled" : "disabled" },
      ...(thinking ? { reasoning_effort: "high" } : {}),
      stream: true,
      max_tokens: 128,
    }),
  });
  if (!response.ok) throw new Error(`Direct provider request failed (${response.status}).`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const consume = (block) => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data || data === "[DONE]") return;
    let chunk;
    try { chunk = JSON.parse(data); } catch { return; }
    const delta = chunk.choices?.[0]?.delta;
    if (delta?.reasoning_content || delta?.content) {
      const now = performance.now();
      firstOutputAt ??= now;
      lastOutputAt = now;
    }
    if (chunk.usage) usage = chunk.usage;
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? "";
    for (const block of blocks) consume(block);
    if (done) break;
  }
  if (buffer.trim()) consume(buffer);
  return metrics({ startedAt, firstOutputAt, lastOutputAt, usage });
}

async function appPathCall(thinking) {
  const baseUrl = required("APP_SMOKE_BASE_URL").replace(/\/$/, "");
  const accessToken = required("APP_SMOKE_ACCESS_TOKEN");
  const conversationId = randomUUID();
  const jobId = randomUUID();
  const request = {
    systemPrompt: "Use concise answers.",
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
  const headers = { authorization: `Bearer ${accessToken}`, "content-type": "application/json" };
  const startedAt = performance.now();
  let firstOutputAt = null;
  let lastOutputAt = null;
  let usage = null;
  let sequence = 0;

  try {
    const submission = await fetch(`${baseUrl}/api/chat`, { method: "POST", headers, body: JSON.stringify(request) });
    if (!submission.ok) throw new Error(`App submission failed (${submission.status}).`);
    const submitted = await submission.json();

    while (true) {
      const response = await fetch(`${baseUrl}/api/chat/jobs/${encodeURIComponent(conversationId)}/${encodeURIComponent(submitted.jobId)}?after=${sequence}`, { headers });
      if (!response.ok) throw new Error(`App job poll failed (${response.status}).`);
      const snapshot = await response.json();
      for (const event of snapshot.events ?? []) {
        if (event.sequence <= sequence) continue;
        sequence = event.sequence;
        if (event.type === "reasoning" || event.type === "content") {
          const now = performance.now();
          firstOutputAt ??= now;
          lastOutputAt = now;
        }
      }
      if (snapshot.usage) usage = snapshot.usage;
      if (["completed", "failed", "cancelled"].includes(snapshot.status)) {
        if (snapshot.status !== "completed") throw new Error(`App job ended ${snapshot.status}.`);
        return metrics({ startedAt, firstOutputAt, lastOutputAt, usage });
      }
      await sleep(POLL_INTERVAL_MS);
    }
  } finally {
    await fetch(`${baseUrl}/api/chat/conversations/${encodeURIComponent(conversationId)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${accessToken}` },
    }).catch(() => undefined);
  }
}

const rows = [];
required("DEEPSEEK_API_KEY");
required("APP_SMOKE_BASE_URL");
required("APP_SMOKE_ACCESS_TOKEN");
for (const thinking of [false, true]) {
  const direct = await directProviderCall(thinking);
  const app = await appPathCall(thinking);
  rows.push({
    thinking,
    directTps: direct.outputTps,
    appTps: app.outputTps,
    ratio: direct.outputTps && app.outputTps ? Number((app.outputTps / direct.outputTps).toFixed(2)) : null,
    directFirstOutputMs: direct.firstOutputLatencyMs,
    appFirstOutputMs: app.firstOutputLatencyMs,
    appCompletionTokens: app.completionTokens,
  });
}

console.table(rows);
