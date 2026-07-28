alter table public.chat_summary_jobs
  add column if not exists result_summary text;

create table if not exists public.user_memory_profiles (
  owner_id uuid primary key,
  revision bigint not null default 0 check (revision >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_memory_folders (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  parent_id uuid,
  name text not null check (char_length(name) between 1 and 80),
  normalized_name text not null,
  created_by text not null check (created_by in ('dreaming', 'agent')),
  source_chat_id text not null,
  source_job_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  foreign key (owner_id) references public.user_memory_profiles(owner_id) on delete cascade,
  foreign key (parent_id) references public.user_memory_folders(id)
);
create unique index if not exists user_memory_folders_active_name
  on public.user_memory_folders(owner_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), normalized_name)
  where deleted_at is null;

create table if not exists public.user_memories (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  folder_id uuid not null,
  content text not null check (char_length(content) between 1 and 2000),
  content_fingerprint text not null,
  source_chat_id text not null,
  source_job_id text not null,
  writer text not null check (writer in ('dreaming', 'agent')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  foreign key (owner_id) references public.user_memory_profiles(owner_id) on delete cascade,
  foreign key (folder_id) references public.user_memory_folders(id)
);
create unique index if not exists user_memories_active_fingerprint
  on public.user_memories(owner_id, folder_id, content_fingerprint)
  where deleted_at is null;
create index if not exists user_memories_folder on public.user_memories(owner_id, folder_id, updated_at desc);

create table if not exists public.user_memory_revisions (
  id bigint generated always as identity primary key,
  owner_id uuid not null,
  profile_revision bigint not null,
  memory_id uuid,
  folder_id uuid,
  operation text not null check (operation in ('create_folder','add','edit','move','delete','merge')),
  before_state jsonb,
  after_state jsonb,
  source_chat_id text not null,
  source_job_id text not null,
  writer text not null check (writer in ('dreaming', 'agent')),
  dreaming_run_id uuid,
  action_index integer,
  created_at timestamptz not null default now(),
  unique (dreaming_run_id, action_index)
);
create index if not exists user_memory_revisions_owner on public.user_memory_revisions(owner_id, id desc);

create table if not exists public.dreaming_completed_jobs (
  sequence bigint generated always as identity,
  owner_id uuid not null,
  job_id text not null,
  conversation_id text not null,
  completed_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (owner_id, job_id),
  unique (sequence)
);

create table if not exists public.dreaming_runs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  status text not null check (status in ('queued','running','completed','failed')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  profile_revision bigint,
  model text,
  action_plan jsonb,
  last_error text,
  lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists dreaming_runs_due on public.dreaming_runs(owner_id, status, created_at);

create table if not exists public.dreaming_run_sources (
  run_id uuid not null references public.dreaming_runs(id) on delete cascade,
  owner_id uuid not null,
  job_id text not null,
  sequence bigint not null,
  conversation_id text not null,
  completed_at timestamptz not null,
  primary key (run_id, job_id),
  unique (owner_id, job_id),
  foreign key (owner_id, job_id) references public.dreaming_completed_jobs(owner_id, job_id) on delete cascade
);

create table if not exists public.dreaming_applied_actions (
  run_id uuid not null references public.dreaming_runs(id) on delete cascade,
  action_index integer not null check (action_index >= 0),
  completed_at timestamptz not null default now(),
  primary key (run_id, action_index)
);

create or replace function public.claim_user_dreaming_run(p_owner_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run_id uuid;
  v_job_count integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text, 701));

  update public.dreaming_runs
    set status = 'queued', lease_expires_at = null, updated_at = now()
    where owner_id = p_owner_id and status = 'running' and lease_expires_at < now();

  select id into v_run_id from public.dreaming_runs
    where owner_id = p_owner_id and status = 'queued'
    order by created_at limit 1;
  if v_run_id is not null then return v_run_id; end if;

  select count(*) into v_job_count from (
    select completed.job_id from public.dreaming_completed_jobs completed
    where completed.owner_id = p_owner_id
      and not exists (
        select 1 from public.dreaming_run_sources source
        where source.owner_id = completed.owner_id and source.job_id = completed.job_id
      )
    order by completed.sequence
    limit 3
  ) candidate;
  if v_job_count < 3 then return null; end if;

  insert into public.dreaming_runs(owner_id, status) values (p_owner_id, 'queued') returning id into v_run_id;
  insert into public.dreaming_run_sources(run_id, owner_id, job_id, sequence, conversation_id, completed_at)
    select v_run_id, completed.owner_id, completed.job_id, completed.sequence, completed.conversation_id, completed.completed_at
    from public.dreaming_completed_jobs completed
    where completed.owner_id = p_owner_id
      and not exists (
        select 1 from public.dreaming_run_sources source
        where source.owner_id = completed.owner_id and source.job_id = completed.job_id
      )
    order by completed.sequence
    limit 3;
  return v_run_id;
end;
$$;

revoke all on function public.claim_user_dreaming_run(uuid) from public, anon, authenticated;
grant execute on function public.claim_user_dreaming_run(uuid) to service_role;

alter table public.user_memory_profiles enable row level security;
alter table public.user_memory_folders enable row level security;
alter table public.user_memories enable row level security;
alter table public.user_memory_revisions enable row level security;
alter table public.dreaming_completed_jobs enable row level security;
alter table public.dreaming_runs enable row level security;
alter table public.dreaming_run_sources enable row level security;
alter table public.dreaming_applied_actions enable row level security;

alter table public.chat_usage_records drop constraint if exists chat_usage_records_request_kind_check;
alter table public.chat_usage_records add constraint chat_usage_records_request_kind_check
  check (request_kind in ('chat', 'title', 'reasoning_summary', 'image_text_analysis', 'image_visual_analysis', 'image_followup', 'chat_summary', 'chat_recall', 'dreaming'));
alter table public.chat_usage_outbox drop constraint if exists chat_usage_outbox_request_kind_check;
alter table public.chat_usage_outbox add constraint chat_usage_outbox_request_kind_check
  check (request_kind in ('chat', 'title', 'reasoning_summary', 'image_text_analysis', 'image_visual_analysis', 'image_followup', 'chat_summary', 'chat_recall', 'dreaming'));
