alter table public.chat_user_preferences
  add column if not exists vision_model jsonb;
