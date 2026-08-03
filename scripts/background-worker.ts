import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { BackgroundWorkerLoop } from "../app/server/worker/worker-loop";
import { closeDatabase } from "../app/server/database/database";
import { claimNextChatJob } from "../app/server/chat/chat-job-store";
import { runClaimedChatJob } from "../app/server/chat/chat-job-runner";
import { claimNextDocumentProcessingJob } from "../app/server/chat/document-processing-job-store";
import { runClaimedDocumentProcessingJob } from "../app/server/chat/document-processing-job-runner";
import { claimNextChatImageProcessingJob } from "../app/server/chat/chat-image-processing-job-store";
import { runClaimedChatImageProcessingJob } from "../app/server/chat/chat-image-processing-job-runner";
import { processChatSummaryForCompletedJob } from "../app/server/chat/chat-summary-service";
import { processDreamingForCompletedJob, processScheduledMemoryWork } from "../app/server/memory/dreaming-service";
import { runAutomationSchedulerTickForOwner } from "../app/server/automations/automation-scheduler";
import { runAbandonedUploadMaintenance, runIncompleteFileMaintenance as runStorageMaintenance, runStaleChatMaintenance } from "../app/server/maintenance/maintenance-service";
import { describeBackgroundError, logBackgroundTaskFailure } from "../app/server/observability/background-error";

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
const automationSchedulerIntervalMs = boundedInteger(process.env.AUTOMATION_SCHEDULER_INTERVAL_MS, 30_000, 5_000, 3_600_000);
const memorySchedulerIntervalMs = boundedInteger(process.env.MEMORY_SCHEDULER_INTERVAL_MS, 60_000, 10_000, 3_600_000);
const schedulerBatch = boundedInteger(process.env.AUTOMATION_SCHEDULER_BATCH, 1, 1, 4);
const maintenanceLimit = boundedInteger(process.env.WORKER_MAINTENANCE_LIMIT, 50, 1, 50);
const chatConcurrency = boundedInteger(process.env.WORKER_CHAT_CONCURRENCY, 1, 1, 1);
const documentConcurrency = boundedInteger(process.env.WORKER_DOCUMENT_CONCURRENCY, 1, 1, 1);
const imageConcurrency = boundedInteger(process.env.WORKER_IMAGE_CONCURRENCY, 1, 1, 1);
const ocrConcurrency = boundedInteger(process.env.WORKER_OCR_CONCURRENCY, 2, 1, 2);
process.env.PDF_OCR_CONCURRENCY = String(ocrConcurrency);

function writeHeartbeat(): void {
  writeFileSync(heartbeatFile, `${new Date().toISOString()}\n`, "utf8");
}

const workerId = randomUUID();
let lastPollLog = 0;
function logPoll(chatClaimed: boolean, documentClaimed: boolean, imageClaimed: boolean): void {
  const now = Date.now();
  if (chatClaimed || documentClaimed || imageClaimed || now - lastPollLog >= 5_000) {
    lastPollLog = now;
    console.log(JSON.stringify({
      event: "background-worker-queue-poll",
      workerId,
      chatClaimed,
      documentClaimed,
      imageClaimed,
      activeChatLimit: chatConcurrency,
      activeDocumentLimit: documentConcurrency,
      activeImageLimit: imageConcurrency,
      ocrPageLimit: ocrConcurrency,
    }));
  }
}

function schedulerTask<T>(task: string, run: () => Promise<T>): () => Promise<T> {
  return async () => {
    const startedAt = Date.now();
    try {
      const result = await run();
      const recordRuns = result && typeof result === "object" && "runs" in result && Array.isArray(result.runs)
        ? result.runs as Array<{ id?: unknown; outcome?: unknown; durationMs?: unknown }>
        : [];
      for (const record of recordRuns) {
        console.log(JSON.stringify({
          event: "background-worker-scheduler",
          task,
          recordId: typeof record.id === "string" ? record.id : "batch",
          durationMs: Number.isFinite(Number(record.durationMs)) ? Number(record.durationMs) : Date.now() - startedAt,
          outcome: typeof record.outcome === "string" ? record.outcome : "completed",
        }));
      }
      if (!recordRuns.length) {
        console.log(JSON.stringify({
          event: "background-worker-scheduler",
          task,
          recordId: "batch",
          durationMs: Date.now() - startedAt,
          outcome: "completed",
          ...(result && typeof result === "object" ? result : {}),
        }));
      }
      return result;
    } catch (error) {
      const details = describeBackgroundError(error);
      console.warn(JSON.stringify({
        event: "background-worker-scheduler",
        task,
        recordId: "batch",
        durationMs: Date.now() - startedAt,
        outcome: "failed",
        errorCode: details.code ?? "UnknownError",
      }));
      throw error;
    }
  };
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
    logPoll(Boolean(claim), false, false);
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
    logPoll(false, Boolean(claim), false);
    return claim;
  },
  executeDocument: async (claim, shutdownSignal) => {
    const document = await runClaimedDocumentProcessingJob(ownerId, claim, { shutdownSignal });
    if (document) console.log(JSON.stringify({ event: "background-worker-document-terminal", workerId, conversationId: claim.conversationId, jobId: claim.jobId, documentId: claim.documentId, status: "completed" }));
  },
  claimImage: async () => {
    const claim = await claimNextChatImageProcessingJob(ownerId);
    logPoll(false, false, Boolean(claim));
    return claim;
  },
  executeImage: async (claim, shutdownSignal) => {
    const image = await runClaimedChatImageProcessingJob(ownerId, claim, { shutdownSignal });
    if (image) console.log(JSON.stringify({ event: "background-worker-image-terminal", workerId, conversationId: claim.conversationId, jobId: claim.jobId, imageId: claim.imageId, status: "completed" }));
  },
  schedulerTasks: [
    {
      name: "automation",
      intervalMs: automationSchedulerIntervalMs,
      run: schedulerTask("automation", async () => runAutomationSchedulerTickForOwner(ownerId, { batchSize: schedulerBatch })),
    },
    {
      name: "memory",
      intervalMs: memorySchedulerIntervalMs,
      run: schedulerTask("memory", async () => processScheduledMemoryWork(ownerId, 8)),
    },
    {
      name: "stale-chat",
      intervalMs: maintenanceIntervalMs,
      run: schedulerTask("stale-chat", async () => ({ deleted: await runStaleChatMaintenance({ ownerId, limit: maintenanceLimit }) })),
    },
    {
      name: "abandoned-upload",
      intervalMs: maintenanceIntervalMs,
      run: schedulerTask("abandoned-upload", async () => ({ cleaned: await runAbandonedUploadMaintenance({ ownerId, limit: maintenanceLimit }) })),
    },
    {
      name: "incomplete-file",
      intervalMs: maintenanceIntervalMs,
      run: schedulerTask("incomplete-file", async () => ({ cleaned: await runStorageMaintenance({ ownerId, limit: maintenanceLimit }) })),
    },
  ],
  onTaskError: (kind, error) => {
    if (kind === "scheduler") {
      const details = describeBackgroundError(error);
      console.warn(JSON.stringify({ event: "background-worker-scheduler-loop-failed", workerId, errorCode: details.code ?? "UnknownError" }));
      return;
    }
    logBackgroundTaskFailure("background-worker-task-failed", { workerId, kind }, error);
  },
});

console.log(JSON.stringify({
  event: "background-worker-started",
  mode: "postgresql-durable-queue",
  workerId,
  chatConcurrency,
  documentConcurrency,
  imageConcurrency,
  ocrConcurrency,
  pollIntervalMs,
  automationSchedulerIntervalMs,
  memorySchedulerIntervalMs,
  maintenanceIntervalMs,
  schedulerBatch,
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
