create table if not exists public.chat_jobs (
  owner_id uuid not null,
  conversation_id text not null,
  job_id text not null,
  idempotency_key text not null,
  request jsonb not null,
  status text not null check (status in ('queued','running','completed','failed','cancelled')),
  error text,
  usage jsonb,
  final_output text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  primary key (owner_id, conversation_id, job_id),
  unique (owner_id, conversation_id, idempotency_key)
);
create table if not exists public.chat_job_events (
  owner_id uuid not null,
  conversation_id text not null,
  job_id text not null,
  sequence bigint generated always as identity,
  event jsonb not null,
  created_at timestamptz not null default now(),
  primary key (owner_id, conversation_id, job_id, sequence),
  foreign key (owner_id, conversation_id, job_id) references public.chat_jobs on delete cascade
);
create index if not exists chat_job_events_replay on public.chat_job_events(owner_id, conversation_id, job_id, sequence);
alter table public.chat_jobs enable row level security;
alter table public.chat_job_events enable row level security;
-- These tables are server-only. The service-role client bypasses RLS; no public policies are intentional.
