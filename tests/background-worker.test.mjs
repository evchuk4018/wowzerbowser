import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { BackgroundWorkerLoop } from "../app/server/worker/worker-loop.ts";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("two simultaneous durable claim attempts have one winner", async () => {
  let claimed = false;
  const claim = async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (claimed) return null;
    claimed = true;
    return { jobId: "one" };
  };
  const results = await Promise.all([claim(), claim()]);
  assert.equal(results.filter(Boolean).length, 1);
});

test("worker loop enforces one active chat, document, and image task and aborts on shutdown", async () => {
  let chatClaims = 0;
  let documentClaims = 0;
  let imageClaims = 0;
  let activeChats = 0;
  let activeDocuments = 0;
  let activeImages = 0;
  let maxChats = 0;
  let maxDocuments = 0;
  let maxImages = 0;
  let chatStarted;
  let documentStarted;
  let imageStarted;
  let release;
  const taskRelease = new Promise((resolve) => { release = resolve; });
  const loop = new BackgroundWorkerLoop({
    chatConcurrency: 1,
    documentConcurrency: 1,
    imageConcurrency: 1,
    pollIntervalMs: 1,
    claimChat: async () => chatClaims++ === 0 ? { jobId: "chat" } : null,
    claimDocument: async () => documentClaims++ === 0 ? { jobId: "document" } : null,
    claimImage: async () => imageClaims++ === 0 ? { jobId: "image" } : null,
    executeChat: async (_claim, signal) => {
      activeChats += 1;
      maxChats = Math.max(maxChats, activeChats);
      chatStarted?.();
      await taskRelease;
      assert.equal(signal.aborted, true);
      activeChats -= 1;
    },
    executeDocument: async (_claim, signal) => {
      activeDocuments += 1;
      maxDocuments = Math.max(maxDocuments, activeDocuments);
      documentStarted?.();
      await taskRelease;
      assert.equal(signal.aborted, true);
      activeDocuments -= 1;
    },
    executeImage: async (_claim, signal) => {
      activeImages += 1;
      maxImages = Math.max(maxImages, activeImages);
      imageStarted?.();
      await taskRelease;
      assert.equal(signal.aborted, true);
      activeImages -= 1;
    },
  });
  const running = loop.run();
  await new Promise((resolve) => { chatStarted = resolve; documentStarted = resolve; imageStarted = resolve; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(maxChats, 1);
  assert.equal(maxDocuments, 1);
  assert.equal(maxImages, 1);
  loop.requestShutdown();
  release();
  await running;
  while (loop.activeTaskCount > 0) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(loop.activeTaskCount, 0);
});

test("worker source uses durable queue claims and the web routes do not execute providers", async () => {
  const [migration, imageMigration, worker, route, imageRoute, imageWorker, finalize] = await Promise.all([
    source("database/migrations/006_durable_worker_queue.sql"),
    source("database/migrations/007_durable_image_processing_queue.sql"),
    source("scripts/background-worker.ts"),
    source("app/api/chat/route.ts"),
    source("app/api/chat/images/route.ts"),
    source("app/server/chat/chat-image-processing-job-runner.ts"),
    source("app/api/chat/documents/finalize/route.ts"),
  ]);
  assert.match(migration, /create table if not exists public\.document_processing_jobs/);
  assert.match(migration, /claim_next_chat_job/);
  assert.match(migration, /claim_next_document_processing_job/);
  assert.match(migration, /for update\s+skip locked/i);
  assert.match(migration, /heartbeat_document_processing_job/);
  assert.match(migration, /cancel_document_processing_job/);
  assert.match(imageMigration, /create table if not exists public\.chat_image_processing_jobs/);
  assert.match(imageMigration, /claim_next_chat_image_processing_job/);
  assert.match(imageMigration, /for update\s+skip locked/i);
  assert.match(imageMigration, /heartbeat_chat_image_processing_job/);
  assert.match(imageMigration, /cancel_chat_image_processing_job/);
  assert.match(worker, /claimNextChatJob/);
  assert.match(worker, /claimNextDocumentProcessingJob/);
  assert.match(worker, /claimNextChatImageProcessingJob/);
  assert.match(worker, /runClaimedChatImageProcessingJob/);
  assert.match(worker, /imageConcurrency/);
  assert.match(worker, /background-worker-queue-poll/);
  assert.doesNotMatch(route, /runChatJob|generateChatResponse/);
  assert.doesNotMatch(imageRoute, /analyzeAndStoreChatImages|analyzeOpenRouterImage/);
  assert.match(imageWorker, /analyzeStoredChatImage/);
  assert.doesNotMatch(finalize, /ingestPdf|ingestDocx|readPendingDocumentUpload/);
});
