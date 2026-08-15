-- User-chosen default chat model used for new conversations without a stored
-- per-conversation preference.
alter table public.chat_user_preferences
  add column if not exists default_model jsonb;
