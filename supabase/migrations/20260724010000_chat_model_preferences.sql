create table if not exists public.chat_model_preferences (
  owner_id uuid not null,
  conversation_id text not null,
  model text not null check (model in ('deepseek-v4-flash', 'deepseek-v4-pro')),
  thinking boolean not null,
  reasoning_effort text not null check (reasoning_effort in ('high', 'max')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, conversation_id)
);

alter table public.chat_model_preferences enable row level security;

-- This table is server-only. The service-role client bypasses RLS; no public policies are intentional.
