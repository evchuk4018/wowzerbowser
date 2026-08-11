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
import { processPendingDiscordMessage } from "../app/server/discord/discord-chat-service";
import { ensureRuntimeConfigLoaded, runtimeConfigSnapshot } from "../app/server/config/runtime-config-service";

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

const ownerId = process.env.APP_OWNER_ID?.trim();
if (!ownerId) throw new Error("APP_OWNER_ID is required for the background worker.");
const runtimeOwnerId = ownerId;
await ensureRuntimeConfigLoaded(runtimeOwnerId);
const runtimeConfig = runtimeConfigSnapshot();
const heartbeatFile = process.env.WORKER_HEARTBEAT_FILE || "/tmp/wowzerbowser-background-worker.heartbeat";
const heartbeatMaxAgeFile = `${heartbeatFile}.max-age`;
const heartbeatIntervalMs = boundedInteger(String(runtimeConfig.workerHeartbeatIntervalMs), 5_000, 1_000, 60_000);
const pollIntervalMs = boundedInteger(String(runtimeConfig.workerPollIntervalMs), 1_000, 250, 10_000);
const maintenanceIntervalMs = boundedInteger(String(runtimeConfig.storageMaintenanceIntervalMs), 60_000, 10_000, 3_600_000);
const automationSchedulerIntervalMs = boundedInteger(String(runtimeConfig.automationSchedulerIntervalMs), 30_000, 5_000, 3_600_000);
const memorySchedulerIntervalMs = boundedInteger(String(runtimeConfig.memorySchedulerIntervalMs), 60_000, 10_000, 3_600_000);
const discordProcessingIntervalMs = boundedInteger(String(runtimeConfig.discordProcessingIntervalMs), 1_000, 1_000, 60_000);
const schedulerBatch = boundedInteger(String(runtimeConfig.automationSchedulerBatch), 1, 1, 4);
const maintenanceLimit = boundedInteger(String(runtimeConfig.workerMaintenanceLimit), 50, 1, 50);
const chatConcurrency = boundedInteger(String(runtimeConfig.workerChatConcurrency), 1, 1, 4);
const documentConcurrency = boundedInteger(String(runtimeConfig.workerDocumentConcurrency), 1, 1, 4);
const imageConcurrency = boundedInteger(String(runtimeConfig.workerImageConcurrency), 1, 1, 4);
const ocrConcurrency = boundedInteger(String(runtimeConfig.workerOcrConcurrency), 2, 1, 2);
const discordProcessingEnabled = Boolean(process.env.DISCORD_ALLOWED_USER_ID?.trim());
process.env.PDF_OCR_CONCURRENCY = String(ocrConcurrency);

function writeHeartbeat(): void {
  writeFileSync(heartbeatFile, `${new Date().toISOString()}\n`, "utf8");
  writeFileSync(heartbeatMaxAgeFile, `${runtimeConfig.workerHeartbeatMaxAgeMs}\n`, "utf8");
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
      await ensureRuntimeConfigLoaded(runtimeOwnerId);
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

/**
 * Summary and memory work is durable and recoverable by the memory scheduler.
 * Keep it out of the interactive chat slot so a slow auxiliary model call
 * cannot make the next user prompt sit in the queue.
 */
async function runPostChatWork(ownerId: string, conversationId: string, jobId: string): Promise<void> {
  await processChatSummaryForCompletedJob(ownerId, conversationId, jobId).catch((error) => {
    logBackgroundTaskFailure("chat-summary-worker-failed", { ownerId, conversationId, jobId }, error);
  });
  await processDreamingForCompletedJob(ownerId, conversationId, jobId).catch((error) => {
    logBackgroundTaskFailure("user-memory-dreaming-worker-failed", { ownerId, conversationId, jobId }, error);
  });
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
    await ensureRuntimeConfigLoaded(runtimeOwnerId);
    const terminal = await runClaimedChatJob(ownerId, claim, { shutdownSignal });
    if (!terminal) return;
    console.log(JSON.stringify({ event: "background-worker-chat-terminal", workerId, conversationId: claim.conversationId, jobId: claim.jobId, status: terminal.status }));
    if (terminal.status !== "completed" || shutdownSignal.aborted) return;
    // Do not hold the single interactive chat slot while auxiliary work runs.
    // The memory scheduler recovers this work if the process shuts down first.
    void runPostChatWork(ownerId, claim.conversationId, claim.jobId);
  },
  claimDocument: async () => {
    const claim = await claimNextDocumentProcessingJob(ownerId);
    logPoll(false, Boolean(claim), false);
    return claim;
  },
  executeDocument: async (claim, shutdownSignal) => {
    await ensureRuntimeConfigLoaded(runtimeOwnerId);
    const document = await runClaimedDocumentProcessingJob(ownerId, claim, { shutdownSignal });
    if (document) console.log(JSON.stringify({ event: "background-worker-document-terminal", workerId, conversationId: claim.conversationId, jobId: claim.jobId, documentId: claim.documentId, status: "completed" }));
  },
  claimImage: async () => {
    const claim = await claimNextChatImageProcessingJob(ownerId);
    logPoll(false, false, Boolean(claim));
    return claim;
  },
  executeImage: async (claim, shutdownSignal) => {
    await ensureRuntimeConfigLoaded(runtimeOwnerId);
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
    ...(discordProcessingEnabled ? [{
      name: "discord-message",
      intervalMs: discordProcessingIntervalMs,
      run: schedulerTask("discord-message", async () => ({ processed: await processPendingDiscordMessage(ownerId) })),
    }] : []),
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
  discordProcessingEnabled,
  discordProcessingIntervalMs,
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
