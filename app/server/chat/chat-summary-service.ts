import "server-only";

import {
  CHAT_SUMMARY_MAX_ATTEMPTS,
  CHAT_SUMMARY_PROCESSING_BUDGET_MS,
  type ChatSummaryInteraction,
  type ChatSummaryTask,
} from "../../../lib/chat-summary";
import { recordUsage } from "../usage/usage-store";
import { summarizeChatWithDeepSeek } from "../../providers/deepseek/deepseek-chat-summary-adapter";
import { DeepSeekError } from "../../providers/deepseek/deepseek-error";
import {
  buildIncrementalChatSummaryPrompt,
  buildRebuildChatSummaryPrompt,
  normalizeChatSummary,
} from "./chat-summary-prompt";
import {
  claimNextChatSummaryTask,
  completeChatSummaryTask,
  enqueueChatSummaryTask,
  failChatSummaryTask,
  getChatSummary,
  getCompletedChatSummaryJobSource,
  listActiveCompletedChatInteractions,
  replaceChatSummaryIfCurrent,
  supersedeChatSummaryTask,
} from "./chat-summary-store";

function enabled(): boolean {
  const summaries = ["1", "true", "yes", "on"].includes(process.env.CHAT_DURABLE_SUMMARIES_ENABLED?.trim().toLowerCase() ?? "");
  const dreaming = !["0", "false", "no", "off"].includes(process.env.USER_MEMORY_DREAMING_ENABLED?.trim().toLowerCase() ?? "");
  return summaries || dreaming;
}

function safeErrorCode(error: unknown): string {
  if (error instanceof DeepSeekError) return error.name || "DeepSeekError";
  if (error instanceof Error) return error.name || "Error";
  return "UnknownError";
}

function retryableError(error: unknown): boolean {
  return error instanceof DeepSeekError && (error.status === 408 || error.status === 429 || error.status >= 500);
}

class ChatSummaryOutputError extends Error {
  constructor() {
    super("The chat summarizer returned invalid output.");
    this.name = "ChatSummaryOutputError";
  }
}

class ChatSummaryConflictError extends Error {
  constructor() {
    super("The chat summary changed while it was being updated.");
    this.name = "ChatSummaryConflictError";
  }
}

function summaryFromAnswer(answer: string, previousSummary: string, rebuild: boolean): string {
  const trimmed = answer.trim();
  if (/^none\.?$/i.test(trimmed)) return rebuild ? "" : previousSummary;
  const normalized = normalizeChatSummary(answer);
  if (!normalized) throw new ChatSummaryOutputError();
  return normalized;
}

function sameSource(
  interactions: ReadonlyArray<ChatSummaryInteraction & { turnId: string; versionId: string; position: number }>,
  task: { sourceTurnId: string; sourceVersionId: string },
): boolean {
  return interactions.some((interaction) => interaction.turnId === task.sourceTurnId && interaction.versionId === task.sourceVersionId);
}

async function persistSummaryUsage(input: {
  ownerId: string;
  conversationId: string;
  jobId: string;
  provider: "deepseek";
  model: string;
  usage: NonNullable<Awaited<ReturnType<typeof summarizeChatWithDeepSeek>>["usage"]>;
}): Promise<void> {
  await recordUsage({
    ownerId: input.ownerId,
    provider: input.provider,
    model: input.model,
    requestKind: "chat_summary",
    requestId: input.jobId,
    round: 0,
    usage: input.usage,
    source: "exact",
    conversationId: input.conversationId,
    jobId: input.jobId,
  }).catch(() => undefined);
}

async function executeChatSummaryTask(task: ChatSummaryTask): Promise<void> {
  const source = await getCompletedChatSummaryJobSource(task.ownerId, task.conversationId, task.sourceJobId);
  if (!source) {
    await supersedeChatSummaryTask(task);
    return;
  }

  const activeInteractions = await listActiveCompletedChatInteractions(task.ownerId, task.conversationId);
  const summaryState = await getChatSummary(task.ownerId, task.conversationId);
  const sourceIsActive = sameSource(activeInteractions, task);
  if (task.mode === "incremental" && !sourceIsActive) {
    await supersedeChatSummaryTask(task);
    return;
  }

  const alreadyCovered = summaryState
    && summaryState.lastSourcePosition >= task.sourcePosition
    && (summaryState.lastSourceVersionId === task.sourceVersionId || sourceIsActive);
  if (alreadyCovered) {
    await completeChatSummaryTask(task, summaryState?.summary ?? "");
    return;
  }

  const needsRebuild = task.mode === "rebuild"
    || !summaryState
    || task.sourcePosition !== summaryState.lastSourcePosition + 1;
  const previousSummary = summaryState?.summary ?? "";
  const prompt = needsRebuild
    ? buildRebuildChatSummaryPrompt(activeInteractions)
    : buildIncrementalChatSummaryPrompt(previousSummary, {
        userContent: source.userContent,
        assistantContent: source.assistantContent,
      });
  const answer = await summarizeChatWithDeepSeek(prompt);
  const summary = summaryFromAnswer(answer.summary, previousSummary, needsRebuild);
  const expectedRevision = summaryState?.revision ?? 0;
  const latestActive = activeInteractions.at(-1);
  const updated = await replaceChatSummaryIfCurrent({
    ownerId: task.ownerId,
    conversationId: task.conversationId,
    expectedRevision,
    summary,
    sourcePosition: needsRebuild ? latestActive?.position ?? task.sourcePosition : task.sourcePosition,
    sourceVersionId: needsRebuild ? latestActive?.versionId ?? task.sourceVersionId : task.sourceVersionId,
    sourceJobId: task.sourceJobId,
  });
  if (!updated) throw new ChatSummaryConflictError();
  if (answer.usage) {
    await persistSummaryUsage({
      ownerId: task.ownerId,
      conversationId: task.conversationId,
      jobId: task.sourceJobId,
      provider: answer.provider,
      model: answer.model,
      usage: answer.usage,
    });
  }
  await completeChatSummaryTask(task, summary);
}

async function processChatSummaryTasks(ownerId: string, conversationId: string): Promise<void> {
  const deadline = Date.now() + CHAT_SUMMARY_PROCESSING_BUDGET_MS;
  while (Date.now() < deadline) {
    const task = await claimNextChatSummaryTask(ownerId, conversationId);
    if (!task) return;
    try {
      await executeChatSummaryTask(task);
    } catch (error) {
      const retryable = error instanceof ChatSummaryConflictError || retryableError(error);
      const message = safeErrorCode(error);
      await failChatSummaryTask(task, message, retryable).catch(() => undefined);
      console.warn({
        event: "chat-summary-failed",
        conversationId,
        sourceJobId: task.sourceJobId,
        attempt: task.attemptCount,
        retryable,
        error: message,
      });
      if (task.attemptCount >= CHAT_SUMMARY_MAX_ATTEMPTS || !retryable) continue;
    }
  }
}

/**
 * Schedules and processes a hidden summary only after the durable chat job is
 * complete. The caller intentionally runs this from Next's after lifecycle.
 */
export async function processChatSummaryForCompletedJob(
  ownerId: string,
  conversationId: string,
  sourceJobId: string,
): Promise<void> {
  if (!enabled()) return;
  const source = await getCompletedChatSummaryJobSource(ownerId, conversationId, sourceJobId);
  if (!source) return;
  await enqueueChatSummaryTask({
    ownerId,
    conversationId,
    sourceJobId,
    sourceTurnId: source.sourceTurnId,
    sourceVersionId: source.sourceVersionId,
    sourcePosition: source.sourcePosition,
    mode: source.request.persistence?.versionIndex && source.request.persistence.versionIndex > 0 ? "rebuild" : "incremental",
  });
  await processChatSummaryTasks(ownerId, conversationId);
}
