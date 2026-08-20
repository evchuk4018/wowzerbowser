import "server-only";

import { databaseOwnerId, isoTimestamp, jsonb, query, withTransaction } from "../database/database";

export type UserQuestionRow = {
  id: string;
  owner_id: string;
  source: "chat" | "automation";
  conversation_id: string | null;
  chat_job_id: string | null;
  automation_run_id: string | null;
  opencode_session_id: string | null;
  question: string;
  context: string | null;
  options: string[] | null;
  status: "pending" | "answered" | "expired";
  answer: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  answered_at: string | null;
};

export type UserQuestion = {
  id: string;
  ownerId: string;
  source: "chat" | "automation";
  conversationId: string | null;
  chatJobId: string | null;
  automationRunId: string | null;
  opencodeSessionId: string | null;
  question: string;
  context: string | null;
  options: string[] | null;
  status: "pending" | "answered" | "expired";
  answer: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  answeredAt: string | null;
};

function rowToQuestion(row: Record<string, unknown>): UserQuestion {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    source: row.source as UserQuestion["source"],
    conversationId: row.conversation_id == null ? null : String(row.conversation_id),
    chatJobId: row.chat_job_id == null ? null : String(row.chat_job_id),
    automationRunId: row.automation_run_id == null ? null : String(row.automation_run_id),
    opencodeSessionId: row.opencode_session_id == null ? null : String(row.opencode_session_id),
    question: String(row.question),
    context: row.context == null ? null : String(row.context),
    options: row.options == null ? null : (row.options as string[]),
    status: row.status as UserQuestion["status"],
    answer: row.answer == null ? null : String(row.answer),
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at),
    expiresAt: row.expires_at == null ? null : isoTimestamp(row.expires_at),
    answeredAt: row.answered_at == null ? null : isoTimestamp(row.answered_at),
  };
}

export async function createUserQuestion(input: {
  ownerId: string;
  source: "chat" | "automation";
  conversationId: string | null;
  chatJobId: string | null;
  automationRunId: string | null;
  question: string;
  context: string | null;
  options: string[] | null;
  opencodeSessionId?: string | null;
  expiresAt: string;
}): Promise<UserQuestion> {
  const [row] = await query<Record<string, unknown>>(
    `insert into user_questions(owner_id,source,conversation_id,chat_job_id,automation_run_id,opencode_session_id,question,context,options,expires_at)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) returning *`,
    [databaseOwnerId(input.ownerId), input.source, input.conversationId, input.chatJobId, input.automationRunId, input.opencodeSessionId ?? null, input.question, input.context, input.options ? jsonb(input.options) : null, input.expiresAt],
  );
  return rowToQuestion(row);
}

export async function getUserQuestion(ownerId: string, id: string): Promise<UserQuestion | null> {
  const [row] = await query<Record<string, unknown>>("select * from user_questions where owner_id=$1 and id=$2", [databaseOwnerId(ownerId), id]);
  return row ? rowToQuestion(row) : null;
}

export async function listPendingUserQuestions(ownerId: string): Promise<UserQuestion[]> {
  const rows = await query<Record<string, unknown>>("select * from user_questions where owner_id=$1 and status='pending' order by created_at asc", [databaseOwnerId(ownerId)]);
  return rows.map(rowToQuestion);
}

export async function answerUserQuestion(ownerId: string, id: string, answer: string): Promise<UserQuestion | null> {
  return withTransaction(async (tx) => {
    const [row] = await tx.unsafe<Record<string, unknown>>("select * from user_questions where owner_id=$1 and id=$2 and status='pending' for update", [databaseOwnerId(ownerId), id]);
    if (!row) return null;
    const now = new Date().toISOString();
    const [updated] = await tx.unsafe<Record<string, unknown>>("update user_questions set status='answered',answer=$1,answered_at=$2,updated_at=$2 where owner_id=$3 and id=$4 returning *", [answer.slice(0, 4000), now, databaseOwnerId(ownerId), id]);
    return updated ? rowToQuestion(updated) : null;
  });
}

export async function expireUserQuestions(ownerId: string, nowIso = new Date().toISOString()): Promise<number> {
  try {
    const rows = await query<{ id: string }>("update user_questions set status='expired',updated_at=$1 where owner_id=$2 and status='pending' and expires_at is not null and expires_at <= $1 returning id", [nowIso, databaseOwnerId(ownerId)]);
    return rows.length;
  } catch (error) {
    if (error instanceof Error && /does not exist|relation/i.test(error.message)) return 0;
    throw error;
  }
}

export async function listUserQuestionsForConversation(ownerId: string, conversationId: string): Promise<UserQuestion[]> {
  const rows = await query<Record<string, unknown>>("select * from user_questions where owner_id=$1 and conversation_id=$2 order by created_at desc", [databaseOwnerId(ownerId), conversationId]);
  return rows.map(rowToQuestion);
}
