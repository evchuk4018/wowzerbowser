import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { closeDatabase, databaseOwnerId, jsonb, query } from "../app/server/database/database.ts";
import { claimNextChatSummaryTask, completeChatSummaryTask, enqueueChatSummaryTask, replaceChatSummaryIfCurrent } from "../app/server/chat/chat-summary-store.ts";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for database integration tests.");
if (!process.env.APP_OWNER_ID) throw new Error("APP_OWNER_ID is required for database integration tests.");

const authOwnerId = "supabase-auth-owner";
const owner = databaseOwnerId(authOwnerId);
const testPrefix = `db-it-${randomUUID()}`;
const conversationIds = new Set();

function requestFor(conversationId, jobId, index = 0) {
  return {
    conversationId,
    jobId,
    idempotencyKey: `${jobId}:idempotency`,
    thinking: false,
    messages: [{ role: "user", content: `integration message ${index}` }],
    persistence: {
      turnId: `${jobId}:turn`,
      versionId: `${jobId}:version`,
      versionIndex: 0,
      turnIndex: 0,
      userMessageId: `${jobId}:user`,
      assistantMessageId: `${jobId}:assistant`,
    },
  };
}

async function submit(request) {
  conversationIds.add(request.conversationId);
  const [jsonProbe] = await query(
    "select jsonb_typeof($1::jsonb) as request_kind, jsonb_typeof($2::jsonb) as attachment_kind, $1::jsonb->>'conversationId' as conversation_id",
    [jsonb(request), jsonb([])],
  );
  assert.equal(jsonProbe.request_kind, "object");
  assert.equal(jsonProbe.attachment_kind, "array");
  assert.equal(jsonProbe.conversation_id, request.conversationId);
  const [row] = await query(
    "select public.submit_and_claim_chat_job(p_owner_id => $1::uuid,p_request => $2::jsonb,p_attachments => $3::jsonb) as result",
    [owner, jsonb(request), jsonb([])],
  );
  return row.result;
}

async function claim(conversationId, jobId, token, leaseMs = 6_000) {
  const [row] = await query("select claim_chat_job($1,$2,$3,$4::uuid,$5,$6) as result", [owner, conversationId, jobId, token, leaseMs, 3]);
  return row.result;
}

test.after(async () => {
  for (const conversationId of conversationIds) {
    await query("delete from chat_jobs where owner_id=$1 and conversation_id=$2", [owner, conversationId]);
    await query("delete from chat_conversations where owner_id=$1 and conversation_id=$2", [owner, conversationId]);
  }
  await closeDatabase();
});

test("local migrations, atomic chat jobs, document registration, and leased summaries work against real PostgreSQL", async () => {
  const migrationRows = await query("select version from schema_migrations order by version");
  assert.deepEqual(migrationRows.map((row) => row.version), ["001_initial_schema", "002_seed_catalog", "003_atomic_functions"]);

  const conversationId = `${testPrefix}-chat`;
  const jobId = `${testPrefix}-job`;
  const request = requestFor(conversationId, jobId);
  const submissions = await Promise.all([submit(request), submit(request)]);
  assert.equal(submissions.filter((value) => value.resumed === false).length, 1);
  assert.equal(submissions.filter((value) => value.resumed === true).length, 1);
  assert.equal(submissions.find((value) => value.resumed === false).status, "queued");
  assert.equal(submissions.find((value) => value.resumed === true).jobId, jobId);

  const token = randomUUID();
  const jobClaim = await claim(conversationId, jobId, token);
  assert.equal(jobClaim.claimed, true);
  assert.equal(jobClaim.status, "running");
  const [eventResult] = await query("select append_chat_job_events($1,$2,$3,$4::uuid,$5::jsonb) as inserted", [
    owner,
    conversationId,
    jobId,
    token,
    jsonb([
      { eventId: `${jobId}:1`, eventIndex: 1, event: { type: "text", text: "hello" } },
      { eventId: `${jobId}:2`, eventIndex: 2, event: { type: "text", text: " world" } },
    ]),
  ]);
  assert.equal(Number(eventResult.inserted), 2);
  const eventRows = await query("select event_index,event_id from chat_job_events where owner_id=$1 and conversation_id=$2 and job_id=$3 order by event_index", [owner, conversationId, jobId]);
  assert.deepEqual(eventRows.map((row) => Number(row.event_index)), [1, 2]);

  const [finished] = await query("select complete_chat_job_and_finalize_message($1,$2,$3,$4::uuid,$5,$6,$7::jsonb,$8) as result", [owner, conversationId, jobId, token, "completed", null, jsonb({ totalTokens: 2 }), "hello world"]);
  assert.equal(finished.result.applied, true);
  const [assistant] = await query("select status,content from chat_messages where owner_id=$1 and conversation_id=$2 and job_id=$3 and role='assistant'", [owner, conversationId, jobId]);
  assert.deepEqual(assistant, { status: "complete", content: "hello world" });

  const concurrentConversation = `${testPrefix}-concurrent`;
  const concurrentJob = `${testPrefix}-concurrent-job`;
  await submit(requestFor(concurrentConversation, concurrentJob, 1));
  const claims = await Promise.all([claim(concurrentConversation, concurrentJob, randomUUID()), claim(concurrentConversation, concurrentJob, randomUUID())]);
  assert.equal(claims.filter((value) => value.claimed).length, 1);
  assert.equal(claims.filter((value) => !value.claimed).length, 1);

  const cancelledConversation = `${testPrefix}-cancel`;
  const cancelledJob = `${testPrefix}-cancel-job`;
  await submit(requestFor(cancelledConversation, cancelledJob, 2));
  const [cancelled] = await query("select cancel_chat_job_and_finalize_message($1,$2,$3) as result", [owner, cancelledConversation, cancelledJob]);
  assert.equal(cancelled.result.applied, true);
  const [cancelledMessage] = await query("select status from chat_messages where owner_id=$1 and conversation_id=$2 and job_id=$3 and role='assistant'", [owner, cancelledConversation, cancelledJob]);
  assert.equal(cancelledMessage.status, "cancelled");

  const documentConversation = `${testPrefix}-document`;
  conversationIds.add(documentConversation);
  const documentId = `${testPrefix}-pdf`;
  const [registered] = await query("select register_chat_document($1,$2,$3::jsonb,$4,$5,$6::jsonb,$7) as result", [
    owner,
    documentConversation,
    jsonb({ id: documentId, name: "report.pdf", contentType: "application/pdf", size: 10, pageCount: 2, tokenEstimate: 5, hasImages: false, imageCount: 0, analyzedImageCount: 0, imageAnalyses: [], origin: "uploaded", editable: false, sourceCompleteness: "complete" }),
    null,
    null,
    jsonb([{ pageNumber: 1, text: "one", extractionMethod: "native" }, { pageNumber: 2, text: "two", extractionMethod: "native" }]),
    `${authOwnerId}/${documentConversation}/${documentId}.pdf`,
  ]);
  assert.equal(registered.result.status, "complete");
  const [document] = await query("select storage_path,status from chat_documents where owner_id=$1 and conversation_id=$2 and document_id=$3", [owner, documentConversation, documentId]);
  assert.deepEqual(document, { storage_path: `${authOwnerId}/${documentConversation}/${documentId}.pdf`, status: "complete" });

  await enqueueChatSummaryTask({ ownerId: authOwnerId, conversationId, sourceJobId: jobId, sourceTurnId: request.persistence.turnId, sourceVersionId: request.persistence.versionId, sourcePosition: 0, mode: "incremental" });
  const tasks = await Promise.all([claimNextChatSummaryTask(authOwnerId, conversationId), claimNextChatSummaryTask(authOwnerId, conversationId)]);
  assert.equal(tasks.filter(Boolean).length, 1);
  const task = tasks.find(Boolean);
  assert.ok(task);
  assert.equal(task.ownerId, authOwnerId);
  assert.equal(task.status, "running");
  assert.equal(await replaceChatSummaryIfCurrent({ ownerId: authOwnerId, conversationId, expectedRevision: 0, summary: "hello world", sourcePosition: 0, sourceVersionId: request.persistence.versionId, sourceJobId: jobId }), true);
  await completeChatSummaryTask(task, "hello world");
  const [summaryJob] = await query("select status from chat_summary_jobs where owner_id=$1 and conversation_id=$2 and source_job_id=$3", [owner, conversationId, jobId]);
  assert.equal(summaryJob.status, "completed");
});
