import "server-only";

import type { ChatModelPreference } from "../../../lib/chat-model-preference";
import { databaseOwnerId, query } from "../database/database";

export async function listChatModelPreferences(ownerId: string) {
  const rows = await query<{ conversation_id: string; provider: string; model: string; thinking: boolean; reasoning_effort: string }>(
    "select conversation_id, provider, model, thinking, reasoning_effort from chat_model_preferences where owner_id = $1 order by conversation_id",
    [databaseOwnerId(ownerId)],
  );
  return rows.map((row) => ({
    conversationId: row.conversation_id as string,
    model: { provider: row.provider ?? "deepseek", model: row.model },
    thinking: row.thinking,
    reasoningEffort: row.reasoning_effort,
  }));
}

export async function saveChatModelPreference(
  ownerId: string,
  conversationId: string,
  preference: ChatModelPreference,
) {
  const owner = databaseOwnerId(ownerId);
  await query(
    `insert into chat_model_preferences (owner_id, conversation_id, provider, model, thinking, reasoning_effort, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (owner_id, conversation_id) do update set provider=excluded.provider, model=excluded.model,
       thinking=excluded.thinking, reasoning_effort=excluded.reasoning_effort, updated_at=excluded.updated_at`,
    [owner, conversationId, preference.model.provider, preference.model.model, preference.thinking, preference.reasoningEffort, new Date().toISOString()],
  );
}

export async function deleteChatModelPreference(ownerId: string, conversationId: string): Promise<void> {
  await query("delete from chat_model_preferences where owner_id = $1 and conversation_id = $2", [databaseOwnerId(ownerId), conversationId]);
}
