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
import type { MemorySummary } from "../../../lib/memory-protocol";
import { databaseOwnerId, isoTimestamp, nullableIsoTimestamp, query } from "../database/database";

type SummaryRow = {
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
  next_attempt_at: unknown;
  lease_expires_at: unknown;
  last_error: string | null;
};

function taskFromRow(row: SummaryJobRow, ownerId: string): ChatSummaryTask {
  return {
    ownerId,
    conversationId: row.conversation_id,
    sourceJobId: row.source_job_id,
    sourceTurnId: row.source_turn_id,
    sourceVersionId: row.source_version_id,
    sourcePosition: Number(row.source_position),
    mode: row.mode,
    status: row.status,
    attemptCount: Number(row.attempt_count),
    nextAttemptAt: isoTimestamp(row.next_attempt_at),
    leaseExpiresAt: nullableIsoTimestamp(row.lease_expires_at),
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

const summaryJobColumns = "owner_id,conversation_id,source_job_id,source_turn_id,source_version_id,source_position,mode,status,attempt_count,next_attempt_at,lease_expires_at,last_error";
const summaryJobReturningColumns = "jobs.owner_id,jobs.conversation_id,jobs.source_job_id,jobs.source_turn_id,jobs.source_version_id,jobs.source_position,jobs.mode,jobs.status,jobs.attempt_count,jobs.next_attempt_at,jobs.lease_expires_at,jobs.last_error";

export async function getChatSummary(ownerId: string, conversationId: string): Promise<ChatSummaryState | null> {
  const [row] = await query<SummaryRow>(
    "select summary,summary_revision,last_source_position,last_source_version_id,last_source_job_id from chat_conversation_summaries where owner_id=$1 and conversation_id=$2",
    [databaseOwnerId(ownerId), conversationId],
  );
  return row ? summaryFromRow(row) : null;
}

export async function listChatConversationSummaries(ownerId: string): Promise<MemorySummary[]> {
  const rows = await query<{
    conversation_id: string;
    title: string | null;
    summary: string;
    summary_revision: number | string;
    updated_at: unknown;
  }>(
    `select summaries.conversation_id,coalesce(conversations.title,'Conversation') as title,
      summaries.summary,summaries.summary_revision,summaries.updated_at
     from chat_conversation_summaries summaries
     left join chat_conversations conversations
       on conversations.owner_id=summaries.owner_id and conversations.conversation_id=summaries.conversation_id
     where summaries.owner_id=$1 order by summaries.updated_at desc`,
    [databaseOwnerId(ownerId)],
  );
  return rows
    .filter((row) => row.summary.trim().length > 0)
    .map((row) => ({
      conversationId: row.conversation_id,
      title: row.title ?? "Conversation",
      summary: row.summary,
      revision: Number(row.summary_revision),
      updatedAt: isoTimestamp(row.updated_at),
    }));
}

async function ensureChatSummary(ownerId: string, conversationId: string): Promise<void> {
  await query(
    `insert into chat_conversation_summaries(owner_id,conversation_id,summary,summary_revision,last_source_position)
     values($1,$2,'',0,-1) on conflict(owner_id,conversation_id) do nothing`,
    [databaseOwnerId(ownerId), conversationId],
  );
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
  const rows = await query(
    `update chat_conversation_summaries set summary=$1,summary_revision=$2,last_source_position=$3,
       last_source_version_id=$4,last_source_job_id=$5,updated_at=$6
     where owner_id=$7 and conversation_id=$8 and summary_revision=$9 returning summary_revision`,
    [input.summary, input.expectedRevision + 1, input.sourcePosition, input.sourceVersionId, input.sourceJobId, new Date().toISOString(), databaseOwnerId(input.ownerId), input.conversationId, input.expectedRevision],
  );
  return rows.length > 0;
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
  await query(
    `insert into chat_summary_jobs(owner_id,conversation_id,source_job_id,source_turn_id,source_version_id,source_position,mode,status,attempt_count,next_attempt_at)
     values($1,$2,$3,$4,$5,$6,$7,'queued',0,$8) on conflict(owner_id,conversation_id,source_job_id) do nothing`,
    [databaseOwnerId(input.ownerId), input.conversationId, input.sourceJobId, input.sourceTurnId, input.sourceVersionId, input.sourcePosition, input.mode, new Date().toISOString()],
  );
}

export async function getChatSummaryTask(ownerId: string, conversationId: string, sourceJobId: string): Promise<ChatSummaryTask | null> {
  const [row] = await query<SummaryJobRow>(
    `select ${summaryJobColumns} from chat_summary_jobs where owner_id=$1 and conversation_id=$2 and source_job_id=$3`,
    [databaseOwnerId(ownerId), conversationId, sourceJobId],
  );
  return row ? taskFromRow(row, ownerId) : null;
}

export async function claimNextChatSummaryTask(ownerId: string, conversationId: string): Promise<ChatSummaryTask | null> {
  const now = new Date();
  const nowIso = now.toISOString();
  const leaseIso = new Date(now.getTime() + CHAT_SUMMARY_LEASE_MS).toISOString();
  const [row] = await query<SummaryJobRow>(
    `with reclaimed as (
       update chat_summary_jobs set status='queued',lease_expires_at=null,updated_at=$3
        where owner_id=$1 and conversation_id=$2 and status='running'
          and lease_expires_at is not null and lease_expires_at < $3
       returning source_job_id
     ), candidate as (
       select source_job_id from chat_summary_jobs
        where owner_id=$1 and conversation_id=$2 and status='queued' and next_attempt_at <= $3
        order by source_position,created_at limit 1 for update skip locked
     )
     update chat_summary_jobs jobs set status='running',attempt_count=jobs.attempt_count+1,
       lease_expires_at=$4,started_at=$3,updated_at=$3
      from candidate where jobs.owner_id=$1 and jobs.conversation_id=$2
        and jobs.source_job_id=candidate.source_job_id and jobs.status='queued'
      returning ${summaryJobReturningColumns}`,
    [databaseOwnerId(ownerId), conversationId, nowIso, leaseIso],
  );
  return row ? taskFromRow(row, ownerId) : null;
}

export async function completeChatSummaryTask(task: ChatSummaryTask, resultSummary: string): Promise<void> {
  await query(
    `update chat_summary_jobs set status='completed',lease_expires_at=null,completed_at=$1,
       result_summary=$2,updated_at=$1
     where owner_id=$3 and conversation_id=$4 and source_job_id=$5 and status='running' and attempt_count=$6`,
    [new Date().toISOString(), resultSummary, databaseOwnerId(task.ownerId), task.conversationId, task.sourceJobId, task.attemptCount],
  );
}

export async function failChatSummaryTask(task: ChatSummaryTask, errorMessage: string, retryable: boolean): Promise<void> {
  const now = new Date();
  const shouldRetry = retryable && task.attemptCount < CHAT_SUMMARY_MAX_ATTEMPTS;
  const retryDelay = CHAT_SUMMARY_RETRY_DELAYS_MS[Math.min(task.attemptCount - 1, CHAT_SUMMARY_RETRY_DELAYS_MS.length - 1)] ?? 3_000;
  if (shouldRetry) {
    await query(
      `update chat_summary_jobs set status='queued',next_attempt_at=$1,lease_expires_at=null,last_error=$2,updated_at=$3
       where owner_id=$4 and conversation_id=$5 and source_job_id=$6 and status='running' and attempt_count=$7`,
      [new Date(now.getTime() + retryDelay).toISOString(), errorMessage, now.toISOString(), databaseOwnerId(task.ownerId), task.conversationId, task.sourceJobId, task.attemptCount],
    );
  } else {
    await query(
      `update chat_summary_jobs set status='failed',completed_at=$1,lease_expires_at=null,last_error=$2,updated_at=$1
       where owner_id=$3 and conversation_id=$4 and source_job_id=$5 and status='running' and attempt_count=$6`,
      [now.toISOString(), errorMessage, databaseOwnerId(task.ownerId), task.conversationId, task.sourceJobId, task.attemptCount],
    );
  }
}

export async function supersedeChatSummaryTask(task: ChatSummaryTask): Promise<void> {
  const now = new Date().toISOString();
  await query(
    `update chat_summary_jobs set status='superseded',lease_expires_at=null,completed_at=$1,updated_at=$1
     where owner_id=$2 and conversation_id=$3 and source_job_id=$4 and status='running' and attempt_count=$5`,
    [now, databaseOwnerId(task.ownerId), task.conversationId, task.sourceJobId, task.attemptCount],
  );
}

export type ChatSummaryJobSource = {
  request: ChatRequest;
  userContent: string;
  assistantContent: string;
  sourceTurnId: string;
  sourceVersionId: string;
  sourcePosition: number;
};

export async function getCompletedChatSummaryJobSource(ownerId: string, conversationId: string, sourceJobId: string): Promise<ChatSummaryJobSource | null> {
  const [data] = await query<{ status: string; request: ChatRequest; final_output: string | null }>(
    "select status,request,final_output from chat_jobs where owner_id=$1 and conversation_id=$2 and job_id=$3",
    [databaseOwnerId(ownerId), conversationId, sourceJobId],
  );
  if (!data || data.status !== "completed") return null;
  const request = data.request;
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

export async function listActiveCompletedChatInteractions(ownerId: string, conversationId: string): Promise<Array<ChatSummaryInteraction & { turnId: string; versionId: string; position: number }>> {
  const owner = databaseOwnerId(ownerId);
  const [turns, versions, messages] = await Promise.all([
    query<{ turn_id: string; position: number | string; active_version: number | string }>("select turn_id,position,active_version from chat_turns where owner_id=$1 and conversation_id=$2 order by position", [owner, conversationId]),
    query<{ turn_id: string; version_id: string; version_index: number | string; parent_version_id: string | null }>("select turn_id,version_id,version_index,parent_version_id from chat_message_versions where owner_id=$1 and conversation_id=$2", [owner, conversationId]),
    query<{ turn_id: string; version_id: string; role: "user" | "assistant"; content: string; status: string | null }>("select turn_id,version_id,role,content,status from chat_messages where owner_id=$1 and conversation_id=$2", [owner, conversationId]),
  ]);

  const versionsByTurn = new Map<string, Array<{ id: string; index: number; parentVersionId?: string }>>();
  for (const row of versions) {
    const values = versionsByTurn.get(row.turn_id) ?? [];
    values.push({ id: row.version_id, index: Number(row.version_index), ...(row.parent_version_id ? { parentVersionId: row.parent_version_id } : {}) });
    versionsByTurn.set(row.turn_id, values);
  }
  const hasLineage = [...versionsByTurn.values()].some((values) => values.some((value) => value.parentVersionId));
  const interactions: Array<ChatSummaryInteraction & { turnId: string; versionId: string; position: number }> = [];
  let parentVersionId: string | null = null;
  for (const turn of turns) {
    const candidates = versionsByTurn.get(turn.turn_id)?.filter((version) => !hasLineage || (version.parentVersionId ?? null) === parentVersionId) ?? [];
    if (!candidates.length) break;
    const version = candidates.find((candidate) => candidate.index === Number(turn.active_version)) ?? candidates.at(-1);
    if (!version) break;
    const pair = messages.filter((message) => message.turn_id === turn.turn_id && message.version_id === version.id);
    const user = pair.find((message) => message.role === "user");
    const assistant = pair.find((message) => message.role === "assistant");
    if (!user || !assistant || assistant.status !== "complete") break;
    interactions.push({ turnId: turn.turn_id, versionId: version.id, position: Number(turn.position), userContent: user.content, assistantContent: assistant.content });
    parentVersionId = version.id;
  }
  return interactions;
}
