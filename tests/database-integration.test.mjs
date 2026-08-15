import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { closeDatabase, databaseOwnerId, jsonb, query } from "../app/server/database/database.ts";
import { resumeChatJobAfterApproval, setChatJobAwaitingApproval } from "../app/server/chat/chat-job-store.ts";
import { claimNextChatSummaryTask, completeChatSummaryTask, enqueueChatSummaryTask, replaceChatSummaryIfCurrent } from "../app/server/chat/chat-summary-store.ts";
import { claimDueAutomationRuns, finishAutomationRun } from "../app/server/automations/automation-repository.ts";
import { nextFutureAutomationRun } from "../app/server/automations/automation-schedule.ts";
import {
  claimDiscordMessage,
  claimPendingDiscordMessage,
  finishDiscordMessagePreparation,
  getDiscordSubmission,
  markDiscordDelivered,
  updateDiscordSubmission,
} from "../app/server/discord/discord-repository.ts";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for database integration tests.");
if (!process.env.APP_OWNER_ID) throw new Error("APP_OWNER_ID is required for database integration tests.");

const authOwnerId = "supabase-auth-owner";
const owner = databaseOwnerId(authOwnerId);
const testPrefix = `db-it-${randomUUID()}`;
const conversationIds = new Set();
const storageObjectIds = new Set();
const automationIds = new Set();
const discordMessageIds = new Set();

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
  for (const objectId of storageObjectIds) {
    await query("delete from app_storage_objects where owner_id=$1 and object_id=$2::uuid", [owner, objectId]);
  }
  for (const automationId of automationIds) {
    await query("delete from automation_runs where owner_id=$1 and automation_id=$2", [owner, automationId]);
    await query("delete from automations where owner_id=$1 and id=$2", [owner, automationId]);
  }
  for (const messageId of discordMessageIds) {
    await query("delete from discord_dm_messages where owner_id=$1 and discord_message_id=$2", [owner, messageId]);
  }
  for (const conversationId of conversationIds) {
    await query("delete from chat_jobs where owner_id=$1 and conversation_id=$2", [owner, conversationId]);
    await query("delete from chat_conversations where owner_id=$1 and conversation_id=$2", [owner, conversationId]);
  }
  await closeDatabase();
});

test("Discord messages are idempotent and recover a preparation lease", async () => {
  const messageId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  discordMessageIds.add(messageId);
  const input = {
    messageId,
    channelId: "2234567890",
    userId: "3234567890",
    responseMessageId: "4234567890",
    content: "/new",
    attachments: [],
  };
  const first = await claimDiscordMessage(authOwnerId, input);
  assert.equal(first.claimed, true);
  assert.equal(first.submission.status, "processing");
  const duplicate = await claimDiscordMessage(authOwnerId, { ...input, content: "should not replace the first delivery" });
  assert.equal(duplicate.claimed, false);
  assert.equal(duplicate.submission.status, "processing");

  const claimed = await claimPendingDiscordMessage(authOwnerId);
  assert.ok(claimed);
  assert.equal(claimed.message.content, "/new");
  assert.equal(await claimPendingDiscordMessage(authOwnerId), null);
  const conversationId = `${testPrefix}-discord-new`;
  await updateDiscordSubmission(authOwnerId, messageId, { conversationId });
  await query("update discord_dm_messages set processing_lease_expires_at=now()-interval '1 second' where owner_id=$1 and discord_message_id=$2", [owner, messageId]);

  const recovered = await claimPendingDiscordMessage(authOwnerId);
  assert.ok(recovered);
  assert.equal(recovered.conversationId, conversationId);
  assert.notEqual(recovered.leaseToken, claimed.leaseToken);
  assert.equal(await finishDiscordMessagePreparation({ ownerId: authOwnerId, messageId, leaseToken: recovered.leaseToken, conversationId, jobId: null, status: "completed", output: "Started a new conversation." }), true);
  const completed = await getDiscordSubmission(authOwnerId, messageId);
  assert.deepEqual(completed, { messageId, channelId: input.channelId, responseMessageId: input.responseMessageId, conversationId, jobId: null, status: "completed", error: null, output: "Started a new conversation." });
  await markDiscordDelivered(authOwnerId, messageId);
  const [delivered] = await query("select delivered_at is not null as delivered from discord_dm_messages where owner_id=$1 and discord_message_id=$2", [owner, messageId]);
  assert.equal(delivered.delivered, true);
});

test("local migrations, atomic chat jobs, document registration, and leased summaries work against real PostgreSQL", async () => {
  const migrationRows = await query("select version from schema_migrations order by version");
  assert.deepEqual(migrationRows.map((row) => row.version), ["001_initial_schema", "002_seed_catalog", "003_atomic_functions", "004_owner_auth", "005_local_filesystem_storage", "006_durable_worker_queue", "007_durable_image_processing_queue", "008_background_scheduler", "009_local_integration_state", "010_open_data_loader_pdf", "011_chat_live_notifications", "012_chat_response_metrics", "013_prompt_cost_accounting", "014_chat_approval_queue", "015_subagent_usage", "016_chat_projects", "017_deepseek_reasoning_pricing", "018_runtime_configurations", "019_google_gmail_connector", "020_microsoft_outlook_connector", "021_voice_transcription", "022_local_drive_connector", "023_local_drive_overwrite_approval", "024_hashed_user_memory", "025_one_off_reminders", "026_default_chat_model", "027_opencode_provider"]);

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

  const approvalConversation = `${testPrefix}-approval`;
  const approvalJob = `${testPrefix}-approval-job`;
  await submit({ ...requestFor(approvalConversation, approvalJob), mode: "deep_research", deepResearchPhase: "plan" });
  const approvalClaim = await claim(approvalConversation, approvalJob, randomUUID());
  assert.equal(approvalClaim.claimed, true);
  assert.equal(approvalClaim.status, "running");
  await setChatJobAwaitingApproval(authOwnerId, approvalConversation, approvalJob, approvalClaim.leaseToken);

  const pausedDirectClaim = await claim(approvalConversation, approvalJob, randomUUID());
  assert.deepEqual(pausedDirectClaim, { claimed: false, status: "awaiting_approval" });
  const [pausedNextClaim] = await query("select claim_next_chat_job($1,$2::uuid,$3,$4) as result", [owner, randomUUID(), 6_000, 3]);
  assert.deepEqual(pausedNextClaim.result, { claimed: false, status: "empty" });
  const [pausedJob] = await query("select status,attempt_count from chat_jobs where owner_id=$1 and conversation_id=$2 and job_id=$3", [owner, approvalConversation, approvalJob]);
  assert.deepEqual(pausedJob, { status: "awaiting_approval", attempt_count: 1 });

  await resumeChatJobAfterApproval(authOwnerId, approvalConversation, approvalJob);
  const [resumedJob] = await query("select status,request->>'deepResearchPhase' as deep_research_phase from chat_jobs where owner_id=$1 and conversation_id=$2 and job_id=$3", [owner, approvalConversation, approvalJob]);
  assert.deepEqual(resumedJob, { status: "queued", deep_research_phase: "execute" });
  const [resumedClaim] = await query("select claim_next_chat_job($1,$2::uuid,$3,$4) as result", [owner, randomUUID(), 6_000, 3]);
  assert.equal(resumedClaim.result.claimed, true);
  assert.equal(resumedClaim.result.status, "running");
  assert.equal(resumedClaim.result.request.deepResearchPhase, "execute");
  assert.equal(resumedClaim.result.attemptCount, 2);
  await query("select cancel_chat_job_and_finalize_message($1,$2,$3) as result", [owner, approvalConversation, approvalJob]);

  const concurrentConversation = `${testPrefix}-concurrent`;
  const concurrentJob = `${testPrefix}-concurrent-job`;
  await submit(requestFor(concurrentConversation, concurrentJob, 1));
  const claims = await Promise.all([claim(concurrentConversation, concurrentJob, randomUUID()), claim(concurrentConversation, concurrentJob, randomUUID())]);
  assert.equal(claims.filter((value) => value.claimed).length, 1);
  assert.equal(claims.filter((value) => !value.claimed).length, 1);

  const recoveryConversation = `${testPrefix}-recovery`;
  const recoveryJob = `${testPrefix}-recovery-job`;
  await submit(requestFor(recoveryConversation, recoveryJob, 3));
  const recoveryToken = randomUUID();
  const firstRecoveryClaim = await claim(recoveryConversation, recoveryJob, recoveryToken);
  assert.equal(firstRecoveryClaim.claimed, true);
  await query("select append_chat_job_events($1,$2,$3,$4::uuid,$5::jsonb) as inserted", [
    owner,
    recoveryConversation,
    recoveryJob,
    recoveryToken,
    jsonb([{ eventId: `${recoveryJob}:1`, eventIndex: 1, event: { type: "text", text: "before restart" } }]),
  ]);
  await query("update chat_jobs set lease_expires_at=now()-interval '1 second' where owner_id=$1 and conversation_id=$2 and job_id=$3", [owner, recoveryConversation, recoveryJob]);
  const [recovered] = await query("select claim_next_chat_job($1,$2::uuid,$3,$4) as result", [owner, randomUUID(), 6_000, 3]);
  assert.equal(recovered.result.claimed, true);
  assert.equal(recovered.result.jobId, recoveryJob);
  assert.equal(recovered.result.attemptCount, 2);
  assert.equal(recovered.result.nextEventIndex, 2);
  await query("select cancel_chat_job_and_finalize_message($1,$2,$3) as result", [owner, recoveryConversation, recoveryJob]);

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

  const processingConversation = `${testPrefix}-document-queue`;
  const processingDocument = `${testPrefix}-queued-pdf`;
  const processingObject = randomUUID();
  const processingJob = `${testPrefix}-document-job`;
  conversationIds.add(processingConversation);
  storageObjectIds.add(processingObject);
  await query("insert into chat_conversations(owner_id,conversation_id) values($1,$2)", [owner, processingConversation]);
  await query("insert into app_storage_objects(object_id,owner_id,conversation_id,document_id,kind,object_key,original_filename,content_type,size,sha256,state,completed_at) values($1::uuid,$2,$3,$4,'document',$5,$6,$7,$8,$9,'complete',now())", [
    processingObject,
    owner,
    processingConversation,
    processingDocument,
    `objects/${processingObject}`,
    "queued.pdf",
    "application/pdf",
    10,
    "a".repeat(64),
  ]);
  const processingRequest = { documentId: processingDocument, storageObjectId: processingObject, filename: "queued.pdf", contentType: "application/pdf", userMessageId: null, sourceJobId: null };
  const [enqueued] = await query("select enqueue_document_processing_job($1,$2,$3,$4,$5,$6::uuid,$7::jsonb) as result", [owner, processingConversation, processingJob, `${processingDocument}:${processingObject}`, processingDocument, processingObject, jsonb(processingRequest)]);
  assert.equal(enqueued.result.status, "queued");
  const [idempotent] = await query("select enqueue_document_processing_job($1,$2,$3,$4,$5,$6::uuid,$7::jsonb) as result", [owner, processingConversation, `${processingJob}-retry`, `${processingDocument}:${processingObject}`, processingDocument, processingObject, jsonb(processingRequest)]);
  assert.equal(idempotent.result.jobId, processingJob);
  const documentClaims = await Promise.all([
    query("select claim_next_document_processing_job($1,$2::uuid,$3,$4) as result", [owner, randomUUID(), 15_000, 3]),
    query("select claim_next_document_processing_job($1,$2::uuid,$3,$4) as result", [owner, randomUUID(), 15_000, 3]),
  ]);
  const claimedDocuments = documentClaims.map(([row]) => row.result).filter((result) => result.claimed);
  assert.equal(claimedDocuments.length, 1);
  const documentClaim = claimedDocuments[0];
  assert.equal(documentClaim.jobId, processingJob);
  const [heartbeat] = await query("select heartbeat_document_processing_job($1,$2,$3,$4::uuid,$5,$6::jsonb) as result", [owner, processingConversation, processingJob, documentClaim.leaseToken, 15_000, jsonb({ stage: "native-parsing", completed: 1, total: 1 })]);
  assert.equal(heartbeat.result.active, true);
  await query("select cancel_document_processing_job($1,$2,$3) as result", [owner, processingConversation, processingJob]);
  const [cancelledDocument] = await query("select status from document_processing_jobs where owner_id=$1 and conversation_id=$2 and job_id=$3", [owner, processingConversation, processingJob]);
  assert.equal(cancelledDocument.status, "cancelled");

  const imageConversation = `${testPrefix}-image-queue`;
  const imageId = `${testPrefix}-image`;
  const imageObject = randomUUID();
  const imageJob = `${testPrefix}-image-job`;
  const imageMessage = `${testPrefix}-image-message`;
  conversationIds.add(imageConversation);
  storageObjectIds.add(imageObject);
  await query("insert into chat_conversations(owner_id,conversation_id) values($1,$2)", [owner, imageConversation]);
  await query("insert into app_storage_objects(object_id,owner_id,conversation_id,message_id,kind,object_key,original_filename,content_type,size,sha256,state,completed_at) values($1::uuid,$2,$3,$4,'image',$5,$6,$7,$8,$9,'complete',now())", [
    imageObject,
    owner,
    imageConversation,
    imageMessage,
    `objects/${imageObject}`,
    "queued.png",
    "image/png",
    24,
    "b".repeat(64),
  ]);
  await query("insert into chat_image_uploads(owner_id,conversation_id,image_id,user_message_id,job_id,storage_path,storage_object_id,name,content_type,size,status,content_hash) values($1,$2,$3,$4,$5,$6,$7::uuid,$8,$9,$10,'processing',$11)", [
    owner,
    imageConversation,
    imageId,
    imageMessage,
    imageJob,
    `objects/${imageObject}`,
    imageObject,
    "queued.png",
    "image/png",
    24,
    "b".repeat(64),
  ]);
  const imageRequest = { imageId, userMessageId: imageMessage, chatJobId: null, storageObjectId: imageObject, name: "queued.png", contentType: "image/png" };
  const [imageEnqueued] = await query("select enqueue_chat_image_processing_job($1,$2,$3,$4,$5,$6,$7,$8::uuid,$9::jsonb) as result", [owner, imageConversation, imageJob, `${imageId}:${imageObject}`, imageId, imageMessage, null, imageObject, jsonb(imageRequest)]);
  assert.equal(imageEnqueued.result.status, "queued");
  const [imageIdempotent] = await query("select enqueue_chat_image_processing_job($1,$2,$3,$4,$5,$6,$7,$8::uuid,$9::jsonb) as result", [owner, imageConversation, `${imageJob}-retry`, `${imageId}:${imageObject}`, imageId, imageMessage, null, imageObject, jsonb(imageRequest)]);
  assert.equal(imageIdempotent.result.jobId, imageJob);
  const imageClaims = await Promise.all([
    query("select claim_next_chat_image_processing_job($1,$2::uuid,$3,$4) as result", [owner, randomUUID(), 15_000, 3]),
    query("select claim_next_chat_image_processing_job($1,$2::uuid,$3,$4) as result", [owner, randomUUID(), 15_000, 3]),
  ]);
  const claimedImages = imageClaims.map(([row]) => row.result).filter((result) => result.claimed);
  assert.equal(claimedImages.length, 1);
  const imageClaim = claimedImages[0];
  assert.equal(imageClaim.jobId, imageJob);
  const [imageHeartbeat] = await query("select heartbeat_chat_image_processing_job($1,$2,$3,$4::uuid,$5,$6::jsonb) as result", [owner, imageConversation, imageJob, imageClaim.leaseToken, 15_000, jsonb({ stage: "waiting-for-upload" })]);
  assert.equal(imageHeartbeat.result.active, true);
  const [imageCancelled] = await query("select cancel_chat_image_processing_job($1,$2,$3) as result", [owner, imageConversation, imageJob]);
  assert.equal(imageCancelled.result.status, "cancelled");
  const [imageResumed] = await query("select resume_chat_image_processing_job($1,$2,$3) as result", [owner, imageConversation, imageJob]);
  assert.equal(imageResumed.result.status, "queued");
  const [imageStatus] = await query("select j.status as job_status,i.status as image_status from chat_image_processing_jobs j join chat_image_uploads i using(owner_id,conversation_id,image_id) where j.owner_id=$1 and j.conversation_id=$2 and j.job_id=$3", [owner, imageConversation, imageJob]);
  assert.deepEqual(imageStatus, { job_status: "queued", image_status: "processing" });
  await query("select cancel_chat_image_processing_job($1,$2,$3) as result", [owner, imageConversation, imageJob]);

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

  const automationId = randomUUID();
  automationIds.add(automationId);
  const dueAt = new Date(Date.now() - 60_000).toISOString();
  await query(
    "insert into automations(id,owner_id,name,kind,instructions,schedule,time_zone,status,next_run_at) values($1,$2,'integration automation','report','deterministic report',$3::jsonb,'Etc/UTC','active',$4)",
    [automationId, owner, jsonb({ kind: "interval", everyMinutes: 15 }), dueAt],
  );
  const automationClaims = await Promise.all([
    claimDueAutomationRuns(authOwnerId, 1, 60_000),
    claimDueAutomationRuns(authOwnerId, 1, 60_000),
  ]);
  const claimedRuns = automationClaims.flat();
  assert.equal(claimedRuns.length, 1);
  assert.equal(claimedRuns[0].automation_id, automationId);
  const nextRun = nextFutureAutomationRun({ kind: "interval", everyMinutes: 15 }, "Etc/UTC", new Date(dueAt), new Date()).toISOString();
  assert.equal(await finishAutomationRun(claimedRuns[0].id, {
    ownerId: authOwnerId,
    leaseToken: claimedRuns[0].lease_token,
    outcome: "no_match",
    matched: false,
    title: "integration",
    output: "not delivered",
    nextRunAt: nextRun,
    pause: false,
  }), true);
  const [advancedAutomation] = await query("select status,next_run_at,last_outcome,consecutive_failures from automations where id=$1", [automationId]);
  assert.equal(advancedAutomation.status, "active");
  assert.equal(advancedAutomation.last_outcome, "no_match");
  assert.equal(Number(advancedAutomation.consecutive_failures), 0);
  assert.equal(Date.parse(advancedAutomation.next_run_at) > Date.now(), true);

  const pausedAutomationId = randomUUID();
  const deletedAutomationId = randomUUID();
  automationIds.add(pausedAutomationId);
  automationIds.add(deletedAutomationId);
  for (const id of [pausedAutomationId, deletedAutomationId]) {
    await query(
      "insert into automations(id,owner_id,name,kind,instructions,schedule,time_zone,status,next_run_at,deleted_at) values($1,$2,$3,'report','not runnable',$4::jsonb,'Etc/UTC',$5,$6,$7)",
      [id, owner, id === pausedAutomationId ? "paused" : "deleted", jsonb({ kind: "interval", everyMinutes: 15 }), "paused", dueAt, id === deletedAutomationId ? new Date().toISOString() : null],
    );
  }
  assert.equal((await claimDueAutomationRuns(authOwnerId, 4, 60_000)).some((claim) => [pausedAutomationId, deletedAutomationId].includes(claim.automation_id)), false);

  const failureAutomationId = randomUUID();
  automationIds.add(failureAutomationId);
  await query(
    "insert into automations(id,owner_id,name,kind,instructions,schedule,time_zone,status,next_run_at) values($1,$2,'failing integration automation','report','fails',$3::jsonb,'Etc/UTC','active',$4)",
    [failureAutomationId, owner, jsonb({ kind: "interval", everyMinutes: 15 }), dueAt],
  );
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [failureClaim] = await claimDueAutomationRuns(authOwnerId, 1, 60_000);
    assert.ok(failureClaim);
    assert.equal(await finishAutomationRun(failureClaim.id, {
      ownerId: authOwnerId,
      leaseToken: failureClaim.lease_token,
      outcome: "failed",
      error: "deterministic failure",
      nextRunAt: new Date(Date.now() - 1_000).toISOString(),
      pause: false,
    }), true);
  }
  const [failedAutomation] = await query("select status,last_outcome,consecutive_failures,next_run_at from automations where id=$1", [failureAutomationId]);
  assert.equal(failedAutomation.status, "paused");
  assert.equal(failedAutomation.last_outcome, "failed");
  assert.equal(Number(failedAutomation.consecutive_failures), 3);
  assert.equal(failedAutomation.next_run_at, null);

  const pausedDuringRunId = randomUUID();
  automationIds.add(pausedDuringRunId);
  await query(
    "insert into automations(id,owner_id,name,kind,instructions,schedule,time_zone,status,next_run_at) values($1,$2,'paused during run','report','pause test',$3::jsonb,'Etc/UTC','active',$4)",
    [pausedDuringRunId, owner, jsonb({ kind: "interval", everyMinutes: 15 }), dueAt],
  );
  const [pausedDuringRunClaim] = await query("select id,lease_token,owner_id,automation_id,scheduled_for,attempt_count from claim_due_automations($1,$2,$3)", [owner, 1, 60_000]);
  await query("update automations set status='paused',next_run_at=null where id=$1", [pausedDuringRunId]);
  assert.equal(await finishAutomationRun(pausedDuringRunClaim.id, {
    ownerId: authOwnerId,
    leaseToken: pausedDuringRunClaim.lease_token,
    outcome: "notified",
    matched: true,
    title: "paused",
    output: "not reactivated",
    nextRunAt: new Date(Date.now() + 900_000).toISOString(),
    pause: false,
  }), true);
  const [pausedDuringRun] = await query("select status,next_run_at from automations where id=$1", [pausedDuringRunId]);
  assert.deepEqual(pausedDuringRun, { status: "paused", next_run_at: null });

  const scheduleChangedId = randomUUID();
  automationIds.add(scheduleChangedId);
  await query(
    "insert into automations(id,owner_id,name,kind,instructions,schedule,time_zone,status,next_run_at) values($1,$2,'schedule changed during run','report','schedule test',$3::jsonb,'Etc/UTC','active',$4)",
    [scheduleChangedId, owner, jsonb({ kind: "interval", everyMinutes: 15 }), dueAt],
  );
  const [scheduleChangedClaim] = await query("select id,lease_token from claim_due_automations($1,$2,$3)", [owner, 1, 60_000]);
  const manuallyScheduled = new Date(Date.now() + 1_800_000).toISOString();
  await query("update automations set next_run_at=$1 where id=$2", [manuallyScheduled, scheduleChangedId]);
  assert.equal(await finishAutomationRun(scheduleChangedClaim.id, {
    ownerId: authOwnerId,
    leaseToken: scheduleChangedClaim.lease_token,
    outcome: "no_match",
    matched: false,
    title: "schedule",
    output: "preserve next run",
    nextRunAt: new Date(Date.now() + 900_000).toISOString(),
    pause: false,
  }), true);
  const [scheduleChanged] = await query("select status,next_run_at from automations where id=$1", [scheduleChangedId]);
  assert.equal(scheduleChanged.status, "active");
  const storedNextRunAt = scheduleChanged.next_run_at instanceof Date
    ? scheduleChanged.next_run_at.getTime()
    : Date.parse(scheduleChanged.next_run_at);
  assert.equal(storedNextRunAt, Date.parse(manuallyScheduled));
});

test("prompt cost refresh aggregates linked non-dreaming work and persists late unpriced state", async () => {
  const conversationId = `${testPrefix}-prompt-cost`;
  const jobId = `${testPrefix}-prompt-cost-job`;
  const request = requestFor(conversationId, jobId);
  await submit(request);
  const token = randomUUID();
  const jobClaim = await claim(conversationId, jobId, token);
  assert.equal(jobClaim.claimed, true);

  await query(
    "insert into chat_usage_records(owner_id,provider,model,request_kind,request_id,round,conversation_id,job_id,prompt_tokens,completion_tokens,total_tokens,cost_usd,usage_source,unpriced) values($1,'openrouter','test-model','chat',$2,0,$3,$4,10,5,15,0.05,'exact',false),($1,'openrouter','test-model','title',$5,0,$3,$4,3,2,5,0.02,'estimated',false),($1,'openrouter','test-model','dreaming',$6,0,$3,$4,100,100,200,99,'exact',false)",
    [owner, `${jobId}:chat`, conversationId, jobId, `${jobId}:title`, `${jobId}:dreaming`],
  );
  const [refreshed] = await query("select refresh_chat_job_cost($1,$2,$3) as result", [owner, conversationId, jobId]);
  assert.deepEqual(refreshed.result, { updated: true, runCost: { costUsd: 0.07, source: "estimated" } });
  const [jobMetrics] = await query("select provider_metrics->'runCost' as run_cost from chat_jobs where owner_id=$1 and conversation_id=$2 and job_id=$3", [owner, conversationId, jobId]);
  assert.deepEqual(jobMetrics.run_cost, { costUsd: 0.07, source: "estimated" });

  await query(
    "insert into chat_usage_records(owner_id,provider,model,request_kind,request_id,round,conversation_id,job_id,prompt_tokens,completion_tokens,total_tokens,cost_usd,usage_source,unpriced) values($1,'openrouter','unknown-model','image_analysis',$2,0,$3,$4,1,1,2,null,'estimated',true)",
    [owner, `${jobId}:image`, conversationId, jobId],
  );
  const [unpriced] = await query("select refresh_chat_job_cost($1,$2,$3) as result", [owner, conversationId, jobId]);
  assert.deepEqual(unpriced.result, { updated: true, runCost: { costUsd: null, source: "unpriced" } });
});
