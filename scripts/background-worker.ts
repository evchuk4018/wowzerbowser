import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { BackgroundWorkerLoop } from "../app/server/worker/worker-loop";
import { closeDatabase } from "../app/server/database/database";
import { claimNextChatJob } from "../app/server/chat/chat-job-store";
import { runClaimedChatJob } from "../app/server/chat/chat-job-runner";
import { claimNextDocumentProcessingJob } from "../app/server/chat/document-processing-job-store";
import { runClaimedDocumentProcessingJob } from "../app/server/chat/document-processing-job-runner";
import { processChatSummaryForCompletedJob } from "../app/server/chat/chat-summary-service";
import { processDreamingForCompletedJob } from "../app/server/memory/dreaming-service";
import { logBackgroundTaskFailure } from "../app/server/observability/background-error";
import { runStorageMaintenance } from "./storage-maintenance.mjs";

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

const ownerId = process.env.APP_OWNER_ID?.trim();
if (!ownerId) throw new Error("APP_OWNER_ID is required for the background worker.");
const heartbeatFile = process.env.WORKER_HEARTBEAT_FILE || "/tmp/wowzerbowser-background-worker.heartbeat";
const heartbeatIntervalMs = boundedInteger(process.env.WORKER_HEARTBEAT_INTERVAL_MS, 5_000, 1_000, 60_000);
const pollIntervalMs = boundedInteger(process.env.WORKER_POLL_INTERVAL_MS, 1_000, 250, 10_000);
const maintenanceIntervalMs = boundedInteger(process.env.STORAGE_MAINTENANCE_INTERVAL_MS, 60_000, 10_000, 3_600_000);
const chatConcurrency = boundedInteger(process.env.WORKER_CHAT_CONCURRENCY, 1, 1, 1);
const documentConcurrency = boundedInteger(process.env.WORKER_DOCUMENT_CONCURRENCY, 1, 1, 1);
const ocrConcurrency = boundedInteger(process.env.WORKER_OCR_CONCURRENCY, 2, 1, 2);
process.env.PDF_OCR_CONCURRENCY = String(ocrConcurrency);

function writeHeartbeat(): void {
  writeFileSync(heartbeatFile, `${new Date().toISOString()}\n`, "utf8");
}

const workerId = randomUUID();
let lastPollLog = 0;
function logPoll(chatClaimed: boolean, documentClaimed: boolean): void {
  const now = Date.now();
  if (chatClaimed || documentClaimed || now - lastPollLog >= 5_000) {
    lastPollLog = now;
    console.log(JSON.stringify({
      event: "background-worker-queue-poll",
      workerId,
      chatClaimed,
      documentClaimed,
      activeChatLimit: chatConcurrency,
      activeDocumentLimit: documentConcurrency,
      ocrPageLimit: ocrConcurrency,
    }));
  }
}

writeHeartbeat();
const heartbeatTimer = setInterval(writeHeartbeat, heartbeatIntervalMs);
const loop = new BackgroundWorkerLoop({
  chatConcurrency,
  documentConcurrency,
  pollIntervalMs,
  maintenanceIntervalMs,
  claimChat: async () => {
    const claim = await claimNextChatJob(ownerId);
    logPoll(Boolean(claim), false);
    return claim;
  },
  executeChat: async (claim, shutdownSignal) => {
    const terminal = await runClaimedChatJob(ownerId, claim, { shutdownSignal });
    if (!terminal) return;
    console.log(JSON.stringify({ event: "background-worker-chat-terminal", workerId, conversationId: claim.conversationId, jobId: claim.jobId, status: terminal.status }));
    if (terminal.status !== "completed" || shutdownSignal.aborted) return;
    await processChatSummaryForCompletedJob(ownerId, claim.conversationId, claim.jobId).catch((error) => {
      logBackgroundTaskFailure("chat-summary-worker-failed", { ownerId, conversationId: claim.conversationId, jobId: claim.jobId }, error);
    });
    await processDreamingForCompletedJob(ownerId, claim.conversationId, claim.jobId).catch((error) => {
      logBackgroundTaskFailure("user-memory-dreaming-worker-failed", { ownerId, conversationId: claim.conversationId, jobId: claim.jobId }, error);
    });
  },
  claimDocument: async () => {
    const claim = await claimNextDocumentProcessingJob(ownerId);
    logPoll(false, Boolean(claim));
    return claim;
  },
  executeDocument: async (claim, shutdownSignal) => {
    const document = await runClaimedDocumentProcessingJob(ownerId, claim, { shutdownSignal });
    if (document) console.log(JSON.stringify({ event: "background-worker-document-terminal", workerId, conversationId: claim.conversationId, jobId: claim.jobId, documentId: claim.documentId, status: "completed" }));
  },
  maintenance: async () => {
    const cleaned = await runStorageMaintenance();
    if (cleaned) console.log(JSON.stringify({ event: "storage-maintenance", cleaned }));
  },
  onTaskError: (kind, error) => {
    logBackgroundTaskFailure("background-worker-task-failed", { workerId, kind }, error);
  },
});

console.log(JSON.stringify({
  event: "background-worker-started",
  mode: "postgresql-durable-queue",
  workerId,
  chatConcurrency,
  documentConcurrency,
  ocrConcurrency,
  pollIntervalMs,
  leaseRecovery: true,
}));

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ event: "background-worker-shutdown-requested", workerId, signal }));
  clearInterval(heartbeatTimer);
  await loop.shutdown();
  await closeDatabase().catch(() => undefined);
  console.log(JSON.stringify({ event: "background-worker-stopped", workerId, signal }));
  process.exit(0);
}

process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
process.once("SIGINT", () => { void shutdown("SIGINT"); });

try {
  await loop.run();
} finally {
  await shutdown("loop-exit");
}
