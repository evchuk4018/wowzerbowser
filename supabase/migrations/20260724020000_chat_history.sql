create table if not exists public.chat_conversations (
  owner_id uuid not null,
  conversation_id text not null,
  title text not null default 'New conversation',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, conversation_id)
);

create table if not exists public.chat_turns (
  owner_id uuid not null,
  conversation_id text not null,
  turn_id text not null,
  position integer not null check (position >= 0),
  active_version integer not null default 0 check (active_version >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, conversation_id, turn_id),
  foreign key (owner_id, conversation_id) references public.chat_conversations on delete cascade
);

create table if not exists public.chat_message_versions (
  owner_id uuid not null,
  conversation_id text not null,
  turn_id text not null,
  version_id text not null,
  version_index integer not null check (version_index >= 0),
  created_at timestamptz not null default now(),
  primary key (owner_id, conversation_id, version_id),
  foreign key (owner_id, conversation_id, turn_id)
    references public.chat_turns(owner_id, conversation_id, turn_id) on delete cascade
);

create table if not exists public.chat_messages (
  owner_id uuid not null,
  conversation_id text not null,
  turn_id text not null,
  version_id text not null,
  message_id text not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null default '',
  reasoning text,
  activities jsonb not null default '[]'::jsonb,
  artifacts jsonb not null default '[]'::jsonb,
  thinking_enabled boolean,
  thinking_duration_ms integer,
  status text check (status in ('streaming', 'complete', 'error', 'cancelled')),
  error text,
  job_id text,
  last_sequence bigint not null default 0,
  trace_round integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, conversation_id, message_id),
  unique (owner_id, conversation_id, version_id, role),
  foreign key (owner_id, conversation_id, turn_id)
    references public.chat_turns(owner_id, conversation_id, turn_id) on delete cascade,
  foreign key (owner_id, conversation_id, version_id)
    references public.chat_message_versions(owner_id, conversation_id, version_id) on delete cascade
);

create index if not exists chat_conversations_updated
  on public.chat_conversations(owner_id, updated_at desc);
create index if not exists chat_messages_conversation
  on public.chat_messages(owner_id, conversation_id, updated_at desc);
create index if not exists chat_messages_jobs
  on public.chat_messages(owner_id, conversation_id, job_id);

create table if not exists public.chat_user_preferences (
  owner_id uuid primary key,
  user_presence text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.chat_conversations enable row level security;
alter table public.chat_turns enable row level security;
alter table public.chat_message_versions enable row level security;
alter table public.chat_messages enable row level security;
alter table public.chat_user_preferences enable row level security;

-- These tables are server-only. The service-role client bypasses RLS;
-- no public policies are intentional.
