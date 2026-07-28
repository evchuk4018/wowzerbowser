create table if not exists public.chat_conversation_summaries (
  owner_id uuid not null,
  conversation_id text not null,
  summary text not null default '',
  summary_revision bigint not null default 0 check (summary_revision >= 0),
  last_source_position integer not null default -1 check (last_source_position >= -1),
  last_source_version_id text,
  last_source_job_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, conversation_id),
  foreign key (owner_id, conversation_id)
    references public.chat_conversations(owner_id, conversation_id) on delete cascade
);

create table if not exists public.chat_summary_jobs (
  owner_id uuid not null,
  conversation_id text not null,
  source_job_id text not null,
  source_turn_id text not null,
  source_version_id text not null,
  source_position integer not null check (source_position >= 0),
  mode text not null check (mode in ('incremental', 'rebuild')),
  status text not null check (status in ('queued', 'running', 'completed', 'failed', 'superseded')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null default now(),
  lease_expires_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  primary key (owner_id, conversation_id, source_job_id),
  foreign key (owner_id, conversation_id)
    references public.chat_conversations(owner_id, conversation_id) on delete cascade,
  foreign key (owner_id, conversation_id, source_job_id)
    references public.chat_jobs(owner_id, conversation_id, job_id) on delete cascade
);

create index if not exists chat_summary_jobs_due
  on public.chat_summary_jobs(owner_id, conversation_id, status, next_attempt_at, source_position);
create unique index if not exists chat_summary_jobs_one_running
  on public.chat_summary_jobs(owner_id, conversation_id)
  where status = 'running';

alter table public.chat_conversation_summaries enable row level security;
alter table public.chat_summary_jobs enable row level security;

-- These tables are server-only. The service-role client bypasses RLS;
-- no public policies are intentional.

alter table public.chat_usage_records
  drop constraint if exists chat_usage_records_request_kind_check;
alter table public.chat_usage_records
  add constraint chat_usage_records_request_kind_check
  check (request_kind in ('chat', 'title', 'reasoning_summary', 'image_text_analysis', 'image_visual_analysis', 'image_followup', 'chat_summary'));

alter table public.chat_usage_outbox
  drop constraint if exists chat_usage_outbox_request_kind_check;
alter table public.chat_usage_outbox
  add constraint chat_usage_outbox_request_kind_check
  check (request_kind in ('chat', 'title', 'reasoning_summary', 'image_text_analysis', 'image_visual_analysis', 'image_followup', 'chat_summary'));

