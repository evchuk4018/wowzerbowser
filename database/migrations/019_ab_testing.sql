alter table public.chat_messages
  add column if not exists experiment_assignment jsonb;

create table if not exists public.ab_experiments (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  name text not null check (char_length(name) between 1 and 120),
  status text not null default 'paused' check (status in ('active','paused','completed')),
  variant_a jsonb not null check (jsonb_typeof(variant_a) = 'object'),
  variant_b jsonb not null check (jsonb_typeof(variant_b) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ab_experiment_assignments (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  experiment_id uuid not null references public.ab_experiments(id) on delete cascade,
  conversation_id text not null,
  turn_id text not null,
  version_id text not null,
  job_id text not null,
  variant text not null check (variant in ('a','b')),
  overrides jsonb not null check (jsonb_typeof(overrides) = 'object'),
  retry boolean not null default false,
  preferred boolean not null default false,
  created_at timestamptz not null default now(),
  unique (owner_id, version_id)
);

create index if not exists ab_experiments_owner_status on public.ab_experiments(owner_id, status, updated_at desc);
create index if not exists ab_assignments_experiment on public.ab_experiment_assignments(owner_id, experiment_id, retry, created_at);
create index if not exists ab_assignments_turn on public.ab_experiment_assignments(owner_id, conversation_id, turn_id, created_at);
create index if not exists ab_assignments_job on public.ab_experiment_assignments(owner_id, conversation_id, job_id);
create unique index if not exists ab_assignments_primary_turn on public.ab_experiment_assignments(owner_id, conversation_id, turn_id) where retry = false;

create or replace function public.submit_and_claim_chat_job(
  p_owner_id uuid,
  p_request jsonb,
  p_attachments jsonb
) returns jsonb
language plpgsql set search_path = public as $$
declare
  persistence jsonb := p_request->'persistence';
  v_conversation_id text := p_request->>'conversationId';
  v_requested_job_id text := p_request->>'jobId';
  v_idempotency_key text := p_request->>'idempotencyKey';
  user_message jsonb := p_request->'messages'->-1;
  existing_job public.chat_jobs%rowtype;
  v_parent_version_id text;
  v_target_parent_version_id text;
  v_active_version_id text;
  v_target_parent_set boolean := false;
  v_turn record;
  now_at timestamptz := clock_timestamp();
begin
  if v_conversation_id is null or v_requested_job_id is null or v_idempotency_key is null
    or persistence is null or user_message->>'role' <> 'user'
    or jsonb_typeof(coalesce(p_attachments, '[]'::jsonb)) <> 'array' then
    raise exception 'Chat persistence metadata is incomplete.' using errcode = '22023';
  end if;

  select * into existing_job from public.chat_jobs
   where owner_id = p_owner_id and conversation_id = v_conversation_id
     and idempotency_key = v_idempotency_key for update;
  if found then
    return jsonb_build_object('jobId', existing_job.job_id, 'status', existing_job.status,
      'resumed', true, 'request', existing_job.request);
  end if;

  select message_version.version_id into v_parent_version_id
    from public.chat_turns preceding_turn
    join public.chat_message_versions message_version
      on message_version.owner_id = preceding_turn.owner_id
     and message_version.conversation_id = preceding_turn.conversation_id
     and message_version.turn_id = preceding_turn.turn_id
     and message_version.version_index = preceding_turn.active_version
   where preceding_turn.owner_id = p_owner_id
     and preceding_turn.conversation_id = v_conversation_id
     and preceding_turn.position = (persistence->>'turnIndex')::integer - 1;

  for v_turn in
    select turn_id, position, active_version from public.chat_turns
     where owner_id = p_owner_id and conversation_id = v_conversation_id
       and position >= (persistence->>'turnIndex')::integer
     order by position for update
  loop
    if not v_target_parent_set then
      v_target_parent_version_id := v_parent_version_id;
      v_target_parent_set := true;
    end if;
    update public.chat_message_versions set parent_version_id = v_parent_version_id
     where owner_id = p_owner_id and conversation_id = v_conversation_id
       and turn_id = v_turn.turn_id and parent_version_id is null;
    select version_id into v_active_version_id from public.chat_message_versions
     where owner_id = p_owner_id and conversation_id = v_conversation_id
       and turn_id = v_turn.turn_id and version_index = v_turn.active_version;
    v_parent_version_id := coalesce(v_active_version_id, v_parent_version_id);
  end loop;
  if not v_target_parent_set then v_target_parent_version_id := v_parent_version_id; end if;

  insert into public.chat_conversations(owner_id, conversation_id, title, updated_at)
    values (p_owner_id, v_conversation_id, 'New conversation', now_at)
    on conflict (owner_id, conversation_id) do update set updated_at = excluded.updated_at;
  insert into public.chat_turns(owner_id, conversation_id, turn_id, position, active_version, updated_at)
    values (p_owner_id, v_conversation_id, persistence->>'turnId',
      (persistence->>'turnIndex')::integer, (persistence->>'versionIndex')::integer, now_at)
    on conflict (owner_id, conversation_id, turn_id) do update
      set active_version = excluded.active_version, updated_at = excluded.updated_at;
  insert into public.chat_message_versions(owner_id, conversation_id, turn_id, version_id, version_index, parent_version_id)
    values (p_owner_id, v_conversation_id, persistence->>'turnId', persistence->>'versionId',
      (persistence->>'versionIndex')::integer, v_target_parent_version_id) on conflict do nothing;
  insert into public.chat_messages(owner_id, conversation_id, turn_id, version_id, message_id, role,
      content, attachments, documents, activities, artifacts, job_id, last_sequence, updated_at)
    values (p_owner_id, v_conversation_id, persistence->>'turnId', persistence->>'versionId',
      persistence->>'userMessageId', 'user', coalesce(user_message->>'content', ''),
      p_attachments, coalesce(user_message->'documents', '[]'::jsonb), '[]'::jsonb, '[]'::jsonb,
      null, 0, now_at) on conflict do nothing;
  insert into public.chat_messages(owner_id, conversation_id, turn_id, version_id, message_id, role,
      content, reasoning, activities, artifacts, experiment_assignment, thinking_enabled, status, job_id, last_sequence, updated_at)
    values (p_owner_id, v_conversation_id, persistence->>'turnId', persistence->>'versionId',
      persistence->>'assistantMessageId', 'assistant', '', '', '[]'::jsonb, '[]'::jsonb,
      p_request->'experiment', coalesce((p_request->>'thinking')::boolean, false), 'streaming', v_requested_job_id, 0, now_at)
    on conflict do nothing;
  insert into public.chat_jobs(owner_id, conversation_id, job_id, idempotency_key, request, status, updated_at)
    values (p_owner_id, v_conversation_id, v_requested_job_id, v_idempotency_key, p_request, 'queued', now_at);
  return jsonb_build_object('jobId', v_requested_job_id, 'status', 'queued', 'resumed', false, 'request', p_request);
exception when unique_violation then
  select * into existing_job from public.chat_jobs
   where owner_id = p_owner_id and conversation_id = v_conversation_id
     and idempotency_key = v_idempotency_key;
  if found then
    return jsonb_build_object('jobId', existing_job.job_id, 'status', existing_job.status,
      'resumed', true, 'request', existing_job.request);
  end if;
  raise;
end;
$$;
