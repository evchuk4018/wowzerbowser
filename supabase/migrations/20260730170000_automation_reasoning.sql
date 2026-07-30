alter table public.chat_user_preferences
  add column if not exists automation_thinking boolean not null default false;
