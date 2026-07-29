import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  normalizeMemoryKey,
  parseDreamingActions,
} from "../lib/user-memory.ts";
import { buildDreamingPrompt } from "../app/server/memory/dreaming-prompt.ts";
import {
  describeBackgroundError,
  formatBackgroundError,
  logBackgroundTaskFailure,
} from "../app/server/observability/background-error.ts";

const source = async (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("background errors preserve database fields and redact credentials", () => {
  const error = {
    code: "23505",
    message: "duplicate key sk-test-secret-value",
    details: "A row already exists.",
    hint: "Use the existing row.",
  };
  assert.deepEqual(describeBackgroundError(error), {
    code: "23505",
    message: "duplicate key [redacted]",
    details: "A row already exists.",
    hint: "Use the existing row.",
  });
  assert.match(formatBackgroundError(error), /\[23505\]/);
  assert.doesNotMatch(formatBackgroundError(error), /sk-test-secret-value/);
});

test("background failure logs retain searchable context and error code", () => {
  const writes = [];
  const originalWarn = console.warn;
  console.warn = (value) => writes.push(value);
  try {
    logBackgroundTaskFailure("user-memory-dreaming-failed", {
      runId: "run-1",
      conversationId: "chat-1",
      jobId: "job-1",
      attempt: 3,
    }, { code: "PGRST116", message: "Expected one row." });
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(writes[0], {
    event: "user-memory-dreaming-failed",
    runId: "run-1",
    conversationId: "chat-1",
    jobId: "job-1",
    attempt: 3,
    errorCode: "PGRST116",
    errorMessage: "Expected one row.",
  });
});

test("memory normalization makes exact duplicate keys stable", () => {
  assert.equal(normalizeMemoryKey("  Pokémon   GO "), normalizeMemoryKey("Pokémon GO"));
});

test("dreaming actions accept an explicit no-op", () => {
  assert.deepEqual(parseDreamingActions({ actions: [{ action: "noop", reason: "Nothing durable." }] }), [
    { action: "noop", reason: "Nothing durable." },
  ]);
  assert.throws(() => parseDreamingActions({ actions: [{ action: "add", path: ["Interests"], content: "Fact" }] }), /provenance/);
});

test("dreaming prompt includes the full profile, summaries, contradiction rules, and no-op instruction", () => {
  const prompt = buildDreamingPrompt({
    revision: 2,
    folders: [{ id: "folder", parentId: null, name: "Interests", path: ["User Profile", "Interests"], createdAt: "2026-01-01" }],
    memories: [{
      id: "memory", folderId: "folder", content: "User likes Pokémon GO.", sourceChatId: "old-chat",
      sourceJobId: "old-job", writer: "agent", createdAt: "2026-01-01", updatedAt: "2026-01-01",
    }],
  }, [{ jobId: "job-3", chatId: "chat-1", completedAt: "2026-01-03", summary: "User no longer plays Pokémon GO." }]);
  assert.match(prompt, /User likes Pokémon GO/);
  assert.match(prompt, /User no longer plays Pokémon GO/);
  assert.match(prompt, /newest completedAt wins/);
  assert.match(prompt, /noop/);
  assert.match(prompt, /untrusted data/);
});

test("Qwen dreaming adapter enables thinking and parses validated JSON actions", async () => {
  const originalKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key";
  const calls = [];
  try {
    const { OPENROUTER_DREAMING_MODEL, consolidateUserMemoryWithQwen } = await import(
      `../app/providers/openrouter/openrouter-dreaming-adapter.ts?test=${Date.now()}`
    );
    const answer = await consolidateUserMemoryWithQwen("prompt", {
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({
          model: OPENROUTER_DREAMING_MODEL,
          choices: [{ message: { content: JSON.stringify({ actions: [{ action: "noop", reason: "No durable facts." }] }) } }],
          usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13, completion_tokens_details: { reasoning_tokens: 2 }, cost: 0.001 },
        }), { status: 200 });
      },
    });
    assert.equal(answer.actions[0].action, "noop");
    assert.equal(answer.usage?.reasoningTokens, 2);
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.model, "qwen/qwen3.7-flash");
    assert.deepEqual(body.reasoning, { enabled: true });
    assert.deepEqual(body.response_format, { type: "json_object" });
  } finally {
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
  }
});

test("persistence schema provides auditable provenance and exclusive three-job batches", async () => {
  const migration = await source("supabase/migrations/20260728200000_user_memory_dreaming.sql");
  assert.match(migration, /user_memory_folders/);
  assert.match(migration, /user_memories/);
  assert.match(migration, /user_memory_revisions/);
  assert.match(migration, /writer in \('dreaming', 'agent'\)/);
  assert.match(migration, /source_chat_id text not null/);
  assert.match(migration, /source_job_id text not null/);
  assert.match(migration, /limit 3/);
  assert.match(migration, /v_job_count < 3/);
  assert.match(migration, /unique \(owner_id, job_id\)/);
  assert.match(migration, /chat_recall', 'dreaming'/);
  assert.match(migration, /owner_id uuid primary key/);
  assert.match(migration, /user_memories\|folder_id uuid/);
  assert.doesNotMatch(migration, /\buser_id\b/);
});

test("dreaming repository deduplicates three source jobs by conversation using the newest source", async () => {
  const repository = await source("app/server/memory/dreaming-repository.ts");
  assert.match(repository, /rows\.length !== 3/);
  assert.match(repository, /newestByChat\.set\(row\.conversation_id, row\)/);
  assert.match(repository, /result_summary/);
  assert.match(repository, /status === "completed"/);
  assert.match(repository, /action_plan,last_error/);
  assert.match(repository, /saveDreamingActionPlan/);
});

test("dreaming stores an action plan before applying it and reuses it on retry", async () => {
  const [service, migration] = await Promise.all([
    source("app/server/memory/dreaming-service.ts"),
    source("supabase/migrations/20260729010000_user_memory_dreaming_reliability.sql"),
  ]);
  assert.match(service, /const persistedActions = run\.actionPlan\?\.actions \?\? null/);
  assert.match(service, /if \(!persistedActions\) await saveDreamingActionPlan/);
  assert.match(service, /for \(const \[index, action\] of actions\.entries\(\)\) await applyAction/);
  assert.match(migration, /add column if not exists result_summary/);
  assert.match(migration, /add column if not exists action_plan/);
});

test("legacy user memory columns cannot block durable profile writes", async () => {
  const migration = await source("supabase/migrations/20260729020000_user_memory_legacy_table_compatibility.sql");
  for (const column of ["user_id", "memory_type", "dedup_key_hash", "origin"]) {
    assert.match(migration, new RegExp(`alter column ${column} drop not null`));
  }
});

test("agent memory tools keep server-owned provenance and expose all requested operations", async () => {
  const [manifest, executor, service] = await Promise.all([
    source("app/server/agent/user-memory-tool-manifest.ts"),
    source("app/server/agent/user-memory-tool.ts"),
    source("app/chat/chat-server-service.ts"),
  ]);
  for (const name of ["browse_user_memory", "read_user_memory", "create_memory_folder", "add_user_memory", "edit_user_memory", "move_user_memory", "delete_user_memory"]) {
    assert.match(manifest, new RegExp(name));
  }
  assert.match(executor, /sourceChatId: context\.conversationId/);
  assert.match(executor, /sourceJobId: context\.jobId/);
  assert.match(executor, /writer: "agent"/);
  assert.match(executor, /formatBackgroundError\(error\)/);
  assert.match(service, /USER_MEMORY_TOOL_INSTRUCTIONS/);
  assert.match(service, /executeUserMemoryTool/);
});

test("post-chat dreaming remains isolated from normal response delivery", async () => {
  const route = await source("app/api/chat/route.ts");
  assert.match(route, /await completion/);
  assert.match(route, /processChatSummaryForCompletedJob/);
  assert.match(route, /processDreamingForCompletedJob/);
  assert.match(route, /user-memory-dreaming-background-failed/);
  assert.match(route, /chat-summary-background-failed/);
});
