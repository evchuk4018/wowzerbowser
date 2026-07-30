create table if not exists public.discord_dm_channels (
  owner_id uuid not null,
  discord_user_id text not null check (discord_user_id ~ '^[0-9]{1,24}$'),
  discord_channel_id text not null check (discord_channel_id ~ '^[0-9]{1,24}$'),
  active_conversation_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, discord_channel_id),
  unique (owner_id, discord_user_id)
);

create table if not exists public.discord_dm_messages (
  owner_id uuid not null,
  discord_message_id text not null check (discord_message_id ~ '^[0-9]{1,24}$'),
  discord_user_id text not null,
  discord_channel_id text not null,
  response_message_id text not null,
  conversation_id text,
  job_id text,
  content text not null default '',
  attachments jsonb not null default '[]'::jsonb,
  status text not null check (status in ('processing', 'running', 'completed', 'failed')),
  error text,
  output text,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, discord_message_id)
);

create index if not exists discord_dm_messages_pending
  on public.discord_dm_messages(owner_id, status, created_at);

alter table public.discord_dm_channels enable row level security;
alter table public.discord_dm_messages enable row level security;

-- Server-only integration state. The service-role client bypasses RLS.
