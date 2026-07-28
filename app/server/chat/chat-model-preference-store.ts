import "server-only";

import type { ChatModelPreference } from "../../../lib/chat-model-preference";
import { getServerClient } from "../../auth/supabase-server-adapter";

export async function listChatModelPreferences(ownerId: string) {
  const { data, error } = await getServerClient()
    .from("chat_model_preferences")
    .select("conversation_id,provider,model,thinking,reasoning_effort")
    .eq("owner_id", ownerId);
  if (error) throw error;
  return (data ?? []).map((row) => ({
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
  const { error } = await getServerClient().from("chat_model_preferences").upsert({
    owner_id: ownerId,
    conversation_id: conversationId,
    provider: preference.model.provider,
    model: preference.model.model,
    thinking: preference.thinking,
    reasoning_effort: preference.reasoningEffort,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}

export async function deleteChatModelPreference(ownerId: string, conversationId: string): Promise<void> {
  const { error } = await getServerClient()
    .from("chat_model_preferences")
    .delete()
    .eq("owner_id", ownerId)
    .eq("conversation_id", conversationId);
  if (error) throw error;
}
