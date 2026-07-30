import "server-only";

import {
  DEFAULT_CHAT_USER_PREFERENCES,
  type ChatUserPreferences,
} from "../../../lib/chat-user-preferences";
import { getServerClient } from "../../auth/supabase-server-adapter";

export async function getChatUserPreferences(ownerId: string): Promise<ChatUserPreferences> {
  const { data, error } = await getServerClient()
    .from("chat_user_preferences")
    .select("user_presence,vision_model,automation_model,focused_context_enabled")
    .eq("owner_id", ownerId)
    .maybeSingle();
  if (error) throw error;
  return data ? {
    userPresence: data.user_presence,
    visionModel: data.vision_model ?? null,
    automationModel: data.automation_model ?? DEFAULT_CHAT_USER_PREFERENCES.automationModel,
    focusedContextEnabled: data.focused_context_enabled ?? false,
  } : DEFAULT_CHAT_USER_PREFERENCES;
}

export async function saveChatUserPreferences(ownerId: string, preferences: ChatUserPreferences): Promise<void> {
  const { error } = await getServerClient().from("chat_user_preferences").upsert({
    owner_id: ownerId,
    user_presence: preferences.userPresence,
    vision_model: preferences.visionModel,
    automation_model: preferences.automationModel ?? DEFAULT_CHAT_USER_PREFERENCES.automationModel,
    focused_context_enabled: preferences.focusedContextEnabled ?? false,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}
