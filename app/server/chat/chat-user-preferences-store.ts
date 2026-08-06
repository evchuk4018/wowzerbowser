import "server-only";

import {
  DEFAULT_CHAT_USER_PREFERENCES,
  type ChatUserPreferences,
} from "../../../lib/chat-user-preferences";
import { databaseOwnerId, jsonb, query } from "../database/database";

export async function getChatUserPreferences(ownerId: string): Promise<ChatUserPreferences> {
  const [data] = await query<{ user_presence: string; vision_model: unknown; automation_model: unknown; focused_context_enabled: boolean }>(
    "select user_presence, vision_model, automation_model, focused_context_enabled from chat_user_preferences where owner_id = $1",
    [databaseOwnerId(ownerId)],
  );
  return data ? {
    userPresence: data.user_presence,
    visionModel: (data.vision_model as ChatUserPreferences["visionModel"] | null) ?? null,
    automationModel: (data.automation_model as ChatUserPreferences["automationModel"] | undefined) ?? DEFAULT_CHAT_USER_PREFERENCES.automationModel,
    focusedContextEnabled: data.focused_context_enabled ?? false,
  } : DEFAULT_CHAT_USER_PREFERENCES;
}

export async function saveChatUserPreferences(ownerId: string, preferences: ChatUserPreferences): Promise<void> {
  const owner = databaseOwnerId(ownerId);
  await query(
    `insert into chat_user_preferences (owner_id, user_presence, vision_model, automation_model, focused_context_enabled, updated_at)
     values ($1, $2, $3::jsonb, $4::jsonb, $5, $6)
     on conflict (owner_id) do update set user_presence=excluded.user_presence, vision_model=excluded.vision_model,
       automation_model=excluded.automation_model,
       focused_context_enabled=excluded.focused_context_enabled, updated_at=excluded.updated_at`,
    [owner, preferences.userPresence, jsonb(preferences.visionModel), jsonb(preferences.automationModel ?? DEFAULT_CHAT_USER_PREFERENCES.automationModel), preferences.focusedContextEnabled ?? false, new Date().toISOString()],
  );
}
