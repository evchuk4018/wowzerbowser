alter table public.chat_messages
  add column if not exists annotations jsonb not null default '[]'::jsonb,
  add column if not exists sources jsonb not null default '[]'::jsonb;
