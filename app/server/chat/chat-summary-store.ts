import "server-only";

import type { ChatRequest } from "../../../lib/chat-protocol";
import {
  CHAT_SUMMARY_MAX_ATTEMPTS,
  CHAT_SUMMARY_LEASE_MS,
  CHAT_SUMMARY_RETRY_DELAYS_MS,
  type ChatSummaryInteraction,
  type ChatSummaryMode,
  type ChatSummaryTask,
} from "../../../lib/chat-summary";
import { getServerClient } from "../../auth/supabase-server-adapter";

const client = () => getServerClient();

type SummaryRow = {
  owner_id: string;
  conversation_id: string;
  summary: string;
  summary_revision: number | string;
  last_source_position: number | string;
  last_source_version_id: string | null;
  last_source_job_id: string | null;
};

type SummaryJobRow = {
  owner_id: string;
  conversation_id: string;
  source_job_id: string;
  source_turn_id: string;
  source_version_id: string;
  source_position: number | string;
  mode: ChatSummaryMode;
  status: ChatSummaryTask["status"];
  attempt_count: number | string;
  next_attempt_at: string;
  lease_expires_at: string | null;
  last_error: string | null;
};

function taskFromRow(row: SummaryJobRow): ChatSummaryTask {
  return {
    ownerId: row.owner_id,
    conversationId: row.conversation_id,
    sourceJobId: row.source_job_id,
    sourceTurnId: row.source_turn_id,
    sourceVersionId: row.source_version_id,
    sourcePosition: Number(row.source_position),
    mode: row.mode,
    status: row.status,
    attemptCount: Number(row.attempt_count),
    nextAttemptAt: row.next_attempt_at,
    leaseExpiresAt: row.lease_expires_at,
    lastError: row.last_error,
  };
}

export type ChatSummaryState = {
  summary: string;
  revision: number;
  lastSourcePosition: number;
  lastSourceVersionId: string | null;
  lastSourceJobId: string | null;
};

function summaryFromRow(row: SummaryRow): ChatSummaryState {
  return {
    summary: row.summary,
    revision: Number(row.summary_revision),
    lastSourcePosition: Number(row.last_source_position),
    lastSourceVersionId: row.last_source_version_id,
    lastSourceJobId: row.last_source_job_id,
  };
}

export async function getChatSummary(
  ownerId: string,
  conversationId: string,
): Promise<ChatSummaryState | null> {
  const { data, error } = await client()
    .from("chat_conversation_summaries")
    .select("summary,summary_revision,last_source_position,last_source_version_id,last_source_job_id")
    .eq("owner_id", ownerId)
    .eq("conversation_id", conversationId)
    .maybeSingle();
  if (error) throw error;
  return data ? summaryFromRow(data as SummaryRow) : null;
}

async function ensureChatSummary(ownerId: string, conversationId: string): Promise<void> {
  const { error } = await client().from("chat_conversation_summaries").upsert({
    owner_id: ownerId,
    conversation_id: conversationId,
    summary: "",
    summary_revision: 0,
    last_source_position: -1,
  }, {
    onConflict: "owner_id,conversation_id",
    ignoreDuplicates: true,
  });
  if (error) throw error;
}

export async function replaceChatSummaryIfCurrent(input: {
  ownerId: string;
  conversationId: string;
  expectedRevision: number;
  summary: string;
  sourcePosition: number;
  sourceVersionId: string;
  sourceJobId: string;
}): Promise<boolean> {
  await ensureChatSummary(input.ownerId, input.conversationId);
  const { data, error } = await client()
    .from("chat_conversation_summaries")
    .update({
      summary: input.summary,
      summary_revision: input.expectedRevision + 1,
      last_source_position: input.sourcePosition,
      last_source_version_id: input.sourceVersionId,
      last_source_job_id: input.sourceJobId,
      updated_at: new Date().toISOString(),
    })
    .eq("owner_id", input.ownerId)
    .eq("conversation_id", input.conversationId)
    .eq("summary_revision", input.expectedRevision)
    .select("summary_revision")
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

export async function enqueueChatSummaryTask(input: {
  ownerId: string;
  conversationId: string;
  sourceJobId: string;
  sourceTurnId: string;
  sourceVersionId: string;
  sourcePosition: number;
  mode: ChatSummaryMode;
}): Promise<void> {
  const { error } = await client().from("chat_summary_jobs").insert({
    owner_id: input.ownerId,
    conversation_id: input.conversationId,
    source_job_id: input.sourceJobId,
    source_turn_id: input.sourceTurnId,
    source_version_id: input.sourceVersionId,
    source_position: input.sourcePosition,
    mode: input.mode,
    status: "queued",
    attempt_count: 0,
    next_attempt_at: new Date().toISOString(),
  });
  if (error && error.code !== "23505") throw error;
}

export async function getChatSummaryTask(
  ownerId: string,
  conversationId: string,
  sourceJobId: string,
): Promise<ChatSummaryTask | null> {
  const { data, error } = await client()
    .from("chat_summary_jobs")
    .select("*")
    .eq("owner_id", ownerId)
    .eq("conversation_id", conversationId)
    .eq("source_job_id", sourceJobId)
    .maybeSingle();
  if (error) throw error;
  return data ? taskFromRow(data as SummaryJobRow) : null;
}

export async function claimNextChatSummaryTask(
  ownerId: string,
  conversationId: string,
): Promise<ChatSummaryTask | null> {
  const now = new Date();
  const nowIso = now.toISOString();
  const leaseIso = new Date(now.getTime() + CHAT_SUMMARY_LEASE_MS).toISOString();

  const { error: reclaimError } = await client()
    .from("chat_summary_jobs")
    .update({ status: "queued", lease_expires_at: null, updated_at: nowIso })
    .eq("owner_id", ownerId)
    .eq("conversation_id", conversationId)
    .eq("status", "running")
    .not("lease_expires_at", "is", null)
    .lt("lease_expires_at", nowIso);
  if (reclaimError) throw reclaimError;

  const { data: candidate, error: candidateError } = await client()
    .from("chat_summary_jobs")
    .select("source_job_id,attempt_count")
    .eq("owner_id", ownerId)
    .eq("conversation_id", conversationId)
    .eq("status", "queued")
    .lte("next_attempt_at", nowIso)
    .order("source_position", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (candidateError) throw candidateError;
  if (!candidate) return null;

  const { data, error } = await client()
    .from("chat_summary_jobs")
    .update({
      status: "running",
      attempt_count: Number(candidate.attempt_count) + 1,
      lease_expires_at: leaseIso,
      started_at: nowIso,
      updated_at: nowIso,
    })
    .eq("owner_id", ownerId)
    .eq("conversation_id", conversationId)
    .eq("source_job_id", candidate.source_job_id)
    .eq("status", "queued")
    .select("*")
    .maybeSingle();
  if (error) {
    if (error.code === "23505") return null;
    throw error;
  }
  return data ? taskFromRow(data as SummaryJobRow) : null;
}

export async function completeChatSummaryTask(task: ChatSummaryTask): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await client()
    .from("chat_summary_jobs")
    .update({
      status: "completed",
      lease_expires_at: null,
      completed_at: now,
      updated_at: now,
    })
    .eq("owner_id", task.ownerId)
    .eq("conversation_id", task.conversationId)
    .eq("source_job_id", task.sourceJobId)
    .eq("status", "running")
    .eq("attempt_count", task.attemptCount);
  if (error) throw error;
}

export async function failChatSummaryTask(
  task: ChatSummaryTask,
  errorMessage: string,
  retryable: boolean,
): Promise<void> {
  const now = new Date();
  const attempt = task.attemptCount;
  const shouldRetry = retryable && attempt < CHAT_SUMMARY_MAX_ATTEMPTS;
  const retryDelay = CHAT_SUMMARY_RETRY_DELAYS_MS[Math.min(attempt - 1, CHAT_SUMMARY_RETRY_DELAYS_MS.length - 1)] ?? 3_000;
  const values = shouldRetry
    ? {
        status: "queued",
        next_attempt_at: new Date(now.getTime() + retryDelay).toISOString(),
        lease_expires_at: null,
        last_error: errorMessage,
        updated_at: now.toISOString(),
      }
    : {
        status: "failed",
        completed_at: now.toISOString(),
        lease_expires_at: null,
        last_error: errorMessage,
        updated_at: now.toISOString(),
      };
  const { error } = await client()
    .from("chat_summary_jobs")
    .update(values)
    .eq("owner_id", task.ownerId)
    .eq("conversation_id", task.conversationId)
    .eq("source_job_id", task.sourceJobId)
    .eq("status", "running")
    .eq("attempt_count", task.attemptCount);
  if (error) throw error;
}

export async function supersedeChatSummaryTask(task: ChatSummaryTask): Promise<void> {
  const { error } = await client()
    .from("chat_summary_jobs")
    .update({
      status: "superseded",
      lease_expires_at: null,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("owner_id", task.ownerId)
    .eq("conversation_id", task.conversationId)
    .eq("source_job_id", task.sourceJobId)
    .eq("status", "running")
    .eq("attempt_count", task.attemptCount);
  if (error) throw error;
}

export type ChatSummaryJobSource = {
  request: ChatRequest;
  userContent: string;
  assistantContent: string;
  sourceTurnId: string;
  sourceVersionId: string;
  sourcePosition: number;
};

export async function getCompletedChatSummaryJobSource(
  ownerId: string,
  conversationId: string,
  sourceJobId: string,
): Promise<ChatSummaryJobSource | null> {
  const { data, error } = await client()
    .from("chat_jobs")
    .select("status,request,final_output")
    .eq("owner_id", ownerId)
    .eq("conversation_id", conversationId)
    .eq("job_id", sourceJobId)
    .maybeSingle();
  if (error) throw error;
  if (!data || data.status !== "completed") return null;
  const request = data.request as ChatRequest;
  const persistence = request.persistence;
  const user = request.messages.at(-1);
  if (!persistence || !user || user.role !== "user") return null;
  return {
    request,
    userContent: user.content,
    assistantContent: typeof data.final_output === "string" ? data.final_output : "",
    sourceTurnId: persistence.turnId,
    sourceVersionId: persistence.versionId,
    sourcePosition: persistence.turnIndex,
  };
}

export async function listActiveCompletedChatInteractions(
  ownerId: string,
  conversationId: string,
): Promise<Array<ChatSummaryInteraction & { turnId: string; versionId: string; position: number }>> {
  const db = client();
  const [turnsResult, versionsResult, messagesResult] = await Promise.all([
    db.from("chat_turns")
      .select("turn_id,position,active_version")
      .eq("owner_id", ownerId)
      .eq("conversation_id", conversationId)
      .order("position", { ascending: true }),
    db.from("chat_message_versions")
      .select("turn_id,version_id,version_index,parent_version_id")
      .eq("owner_id", ownerId)
      .eq("conversation_id", conversationId),
    db.from("chat_messages")
      .select("turn_id,version_id,role,content,status")
      .eq("owner_id", ownerId)
      .eq("conversation_id", conversationId),
  ]);
  if (turnsResult.error) throw turnsResult.error;
  if (versionsResult.error) throw versionsResult.error;
  if (messagesResult.error) throw messagesResult.error;

  const versionsByTurn = new Map<string, Array<{ id: string; index: number; parentVersionId?: string }>>();
  for (const row of versionsResult.data ?? []) {
    const versions = versionsByTurn.get(row.turn_id) ?? [];
    versions.push({
      id: row.version_id,
      index: Number(row.version_index),
      ...(typeof row.parent_version_id === "string" ? { parentVersionId: row.parent_version_id } : {}),
    });
    versionsByTurn.set(row.turn_id, versions);
  }
  const messages = (messagesResult.data ?? []) as Array<{
    turn_id: string;
    version_id: string;
    role: "user" | "assistant";
    content: string;
    status: string | null;
  }>;

  const hasLineage = [...versionsByTurn.values()].some((versions) =>
    versions.some((version) => typeof version.parentVersionId === "string"),
  );
  const interactions: Array<ChatSummaryInteraction & { turnId: string; versionId: string; position: number }> = [];
  let parentVersionId: string | null = null;
  for (const turn of turnsResult.data ?? []) {
    const candidates = versionsByTurn.get(turn.turn_id)?.filter((version) =>
      !hasLineage || (version.parentVersionId ?? null) === parentVersionId,
    ) ?? [];
    if (!candidates.length) break;
    const version = candidates.find(({ index }) => index === Number(turn.active_version)) ?? candidates.at(-1);
    if (!version) break;
    const pair = messages.filter((message) => message.turn_id === turn.turn_id && message.version_id === version.id);
    const user = pair.find((message) => message.role === "user");
    const assistant = pair.find((message) => message.role === "assistant");
    if (!user || !assistant || assistant.status !== "complete") break;
    interactions.push({
      turnId: turn.turn_id,
      versionId: version.id,
      position: Number(turn.position),
      userContent: user.content,
      assistantContent: assistant.content,
    });
    parentVersionId = version.id;
  }
  return interactions;
}
