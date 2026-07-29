alter table public.chat_summary_jobs
  add column if not exists result_summary text;

-- Keep a partially-created schema runnable. `create table if not exists`
-- does not add columns to an existing relation, so repair the columns used
-- below before the indexes, foreign keys, and function are created.
do $$
declare
  repair_definition text;
  memory_table text;
  column_definition text;
  target_column_name text;
begin
  foreach repair_definition in array array[
    'user_memory_profiles|owner_id uuid',
    'user_memory_profiles|revision bigint default 0',
    'user_memory_profiles|created_at timestamptz default now()',
    'user_memory_profiles|updated_at timestamptz default now()',
    'user_memory_folders|id uuid default gen_random_uuid()',
    'user_memory_folders|owner_id uuid',
    'user_memory_folders|parent_id uuid',
    'user_memory_folders|name text',
    'user_memory_folders|normalized_name text',
    'user_memory_folders|created_by text',
    'user_memory_folders|source_chat_id text',
    'user_memory_folders|source_job_id text',
    'user_memory_folders|created_at timestamptz default now()',
    'user_memory_folders|updated_at timestamptz default now()',
    'user_memory_folders|deleted_at timestamptz',
    'user_memories|id uuid default gen_random_uuid()',
    'user_memories|owner_id uuid',
    'user_memories|folder_id uuid',
    'user_memories|content text',
    'user_memories|content_fingerprint text',
    'user_memories|source_chat_id text',
    'user_memories|source_job_id text',
    'user_memories|writer text',
    'user_memories|created_at timestamptz default now()',
    'user_memories|updated_at timestamptz default now()',
    'user_memories|deleted_at timestamptz',
    'user_memory_revisions|id bigint generated always as identity',
    'user_memory_revisions|owner_id uuid',
    'user_memory_revisions|profile_revision bigint',
    'user_memory_revisions|memory_id uuid',
    'user_memory_revisions|folder_id uuid',
    'user_memory_revisions|operation text',
    'user_memory_revisions|before_state jsonb',
    'user_memory_revisions|after_state jsonb',
    'user_memory_revisions|source_chat_id text',
    'user_memory_revisions|source_job_id text',
    'user_memory_revisions|writer text',
    'user_memory_revisions|dreaming_run_id uuid',
    'user_memory_revisions|action_index integer',
    'user_memory_revisions|created_at timestamptz default now()',
    'dreaming_completed_jobs|sequence bigint generated always as identity',
    'dreaming_completed_jobs|owner_id uuid',
    'dreaming_completed_jobs|job_id text',
    'dreaming_completed_jobs|conversation_id text',
    'dreaming_completed_jobs|completed_at timestamptz',
    'dreaming_completed_jobs|created_at timestamptz default now()',
    'dreaming_runs|id uuid default gen_random_uuid()',
    'dreaming_runs|owner_id uuid',
    'dreaming_runs|status text',
    'dreaming_runs|attempt_count integer default 0',
    'dreaming_runs|profile_revision bigint',
    'dreaming_runs|model text',
    'dreaming_runs|action_plan jsonb',
    'dreaming_runs|last_error text',
    'dreaming_runs|lease_expires_at timestamptz',
    'dreaming_runs|created_at timestamptz default now()',
    'dreaming_runs|started_at timestamptz',
    'dreaming_runs|completed_at timestamptz',
    'dreaming_runs|updated_at timestamptz default now()',
    'dreaming_run_sources|run_id uuid',
    'dreaming_run_sources|owner_id uuid',
    'dreaming_run_sources|job_id text',
    'dreaming_run_sources|sequence bigint',
    'dreaming_run_sources|conversation_id text',
    'dreaming_run_sources|completed_at timestamptz',
    'dreaming_applied_actions|run_id uuid',
    'dreaming_applied_actions|action_index integer',
    'dreaming_applied_actions|completed_at timestamptz default now()'
  ] loop
    memory_table := split_part(repair_definition, '|', 1);
    column_definition := split_part(repair_definition, '|', 2);
    target_column_name := split_part(column_definition, ' ', 1);
    if to_regclass(format('public.%I', memory_table)) is not null
      and exists (
        select 1
        from pg_class relation
        join pg_namespace namespace on namespace.oid = relation.relnamespace
        where namespace.nspname = 'public'
          and relation.relname = memory_table
          and relation.relkind in ('r', 'p')
      )
      and not exists (
        select 1
        from information_schema.columns as columns
        where columns.table_schema = 'public'
          and columns.table_name = memory_table
          and columns.column_name = target_column_name
      ) then
      execute format('alter table public.%I add column %s', memory_table, column_definition);
    end if;
  end loop;
end;
$$;

create table if not exists public.user_memory_profiles (
  owner_id uuid primary key,
  revision bigint not null default 0 check (revision >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists user_memory_profiles_owner
  on public.user_memory_profiles(owner_id);

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

  update public.dreaming_runs as runs
    set status = 'queued', lease_expires_at = null, updated_at = now()
    where runs.owner_id = p_owner_id and runs.status = 'running' and runs.lease_expires_at < now();

  select runs.id into v_run_id from public.dreaming_runs as runs
    where runs.owner_id = p_owner_id and runs.status = 'queued'
    order by runs.created_at limit 1;
  if v_run_id is not null then return v_run_id; end if;

  select count(*) into v_job_count from (
    select completed.job_id from public.dreaming_completed_jobs as completed
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
    from public.dreaming_completed_jobs as completed
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
