import "server-only";

import type { ChatRunCost } from "../../../lib/chat-protocol";
import { databaseOwnerId, query } from "../database/database";

function parseRunCost(value: unknown): ChatRunCost | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const source = record.source;
  if (source !== "exact" && source !== "estimated" && source !== "unpriced") return null;
  const costUsd = record.costUsd === null || record.costUsd === undefined
    ? null
    : Number(record.costUsd);
  if (costUsd !== null && (!Number.isFinite(costUsd) || costUsd < 0)) return null;
  return { costUsd, source };
}

export async function refreshChatJobCost(
  ownerId: string,
  conversationId: string,
  jobId: string,
): Promise<ChatRunCost | null> {
  const rows = await query<{ result: unknown }>(
    "select public.refresh_chat_job_cost($1,$2,$3) as result",
    [databaseOwnerId(ownerId), conversationId, jobId],
  );
  const result = rows[0]?.result;
  if (!result || typeof result !== "object") return null;
  return parseRunCost((result as Record<string, unknown>).runCost);
}
