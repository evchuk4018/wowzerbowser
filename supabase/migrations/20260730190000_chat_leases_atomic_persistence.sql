-- Chat jobs are durable work items. Claims are fenced by a token so an old
-- worker cannot finish or append events after its lease has been reclaimed.
alter table public.chat_jobs
  add column if not exists lease_expires_at timestamptz,
  add column if not exists heartbeat_at timestamptz,
  add column if not exists attempt_count integer not null default 0;

alter table public.chat_jobs
  add column if not exists lease_token uuid;

alter table public.chat_jobs
  drop constraint if exists chat_jobs_attempt_count_check;
alter table public.chat_jobs
  add constraint chat_jobs_attempt_count_check check (attempt_count >= 0);

create index if not exists chat_jobs_claimable
  on public.chat_jobs(status, lease_expires_at, created_at);

alter table public.chat_job_events
  add column if not exists event_id text;

update public.chat_job_events
set event_id = job_id || ':' || event_index::text
where event_id is null;

alter table public.chat_job_events
  alter column event_id set not null;

create unique index if not exists chat_job_events_event_id
  on public.chat_job_events(owner_id, conversation_id, job_id, event_id);

create or replace function public.submit_and_claim_chat_job(
  p_owner_id uuid,
  p_request jsonb,
  p_attachments jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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
    where owner_id = p_owner_id and chat_jobs.conversation_id = v_conversation_id
      and chat_jobs.idempotency_key = v_idempotency_key
    for update;
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
    select turn_id, position, active_version
    from public.chat_turns
    where owner_id = p_owner_id
      and conversation_id = v_conversation_id
      and position >= (persistence->>'turnIndex')::integer
    order by position
  loop
    if not v_target_parent_set then
      v_target_parent_version_id := v_parent_version_id;
      v_target_parent_set := true;
    end if;
    update public.chat_message_versions
      set parent_version_id = v_parent_version_id
      where owner_id = p_owner_id
        and conversation_id = v_conversation_id
        and turn_id = v_turn.turn_id
        and parent_version_id is null;
    v_active_version_id := null;
    select version_id into v_active_version_id
      from public.chat_message_versions
      where owner_id = p_owner_id
        and conversation_id = v_conversation_id
        and turn_id = v_turn.turn_id
        and version_index = v_turn.active_version;
    v_parent_version_id := coalesce(v_active_version_id, v_parent_version_id);
  end loop;
  if not v_target_parent_set then
    v_target_parent_version_id := v_parent_version_id;
  end if;

  insert into public.chat_conversations(owner_id, conversation_id, title, updated_at)
    values (p_owner_id, v_conversation_id, 'New conversation', now_at)
    on conflict (owner_id, conversation_id) do update set updated_at = excluded.updated_at;
  insert into public.chat_turns(owner_id, conversation_id, turn_id, position, active_version, updated_at)
    values (p_owner_id, v_conversation_id, persistence->>'turnId', (persistence->>'turnIndex')::integer,
      (persistence->>'versionIndex')::integer, now_at)
    on conflict (owner_id, conversation_id, turn_id) do update
      set active_version = excluded.active_version, updated_at = excluded.updated_at;
  insert into public.chat_message_versions(owner_id, conversation_id, turn_id, version_id, version_index, parent_version_id)
    values (p_owner_id, v_conversation_id, persistence->>'turnId', persistence->>'versionId',
      (persistence->>'versionIndex')::integer, v_target_parent_version_id) on conflict do nothing;
  insert into public.chat_messages(owner_id, conversation_id, turn_id, version_id, message_id, role,
      content, attachments, documents, activities, artifacts, job_id, last_sequence, updated_at)
    values (p_owner_id, v_conversation_id, persistence->>'turnId', persistence->>'versionId',
      persistence->>'userMessageId', 'user', coalesce(user_message->>'content', ''),
      p_attachments, coalesce(user_message->'documents', '[]'::jsonb),
      '[]'::jsonb, '[]'::jsonb, null, 0, now_at) on conflict do nothing;
  insert into public.chat_messages(owner_id, conversation_id, turn_id, version_id, message_id, role,
      content, reasoning, activities, artifacts, thinking_enabled, status, job_id, last_sequence, updated_at)
    values (p_owner_id, v_conversation_id, persistence->>'turnId', persistence->>'versionId',
      persistence->>'assistantMessageId', 'assistant', '', '', '[]'::jsonb, '[]'::jsonb,
      coalesce((p_request->>'thinking')::boolean, false), 'streaming', v_requested_job_id, 0, now_at)
    on conflict do nothing;
  insert into public.chat_jobs(owner_id, conversation_id, job_id, idempotency_key, request, status,
      attempt_count, updated_at)
    values (p_owner_id, v_conversation_id, v_requested_job_id, v_idempotency_key, p_request, 'queued', 0, now_at);

  return jsonb_build_object('jobId', v_requested_job_id, 'status', 'queued',
    'resumed', false, 'request', p_request);
exception when unique_violation then
  select * into existing_job from public.chat_jobs
    where owner_id = p_owner_id and chat_jobs.conversation_id = v_conversation_id
      and chat_jobs.idempotency_key = v_idempotency_key;
  if found then
    return jsonb_build_object('jobId', existing_job.job_id, 'status', existing_job.status,
      'resumed', true, 'request', existing_job.request);
  end if;
  raise;
end;
$$;

-- Keep the older server contract safe for already-deployed callers.
drop function if exists public.submit_and_claim_chat_job(uuid, jsonb);
create or replace function public.submit_and_claim_chat_job(
  p_owner_id uuid,
  p_request jsonb
) returns jsonb
language sql
security definer
set search_path = public
as $$
  select public.submit_and_claim_chat_job(
    p_owner_id,
    p_request,
    coalesce(p_request->'messages'->-1->'attachments', '[]'::jsonb)
  );
$$;

create or replace function public.claim_chat_job(
  p_owner_id uuid,
  p_conversation_id text,
  p_job_id text,
  p_worker_token uuid,
  p_lease_ms integer default 6000,
  p_max_attempts integer default 3
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  job public.chat_jobs%rowtype;
  now_at timestamptz := clock_timestamp();
  lease_until timestamptz;
begin
  if p_lease_ms < 1000 or p_max_attempts < 1 then
    raise exception 'Invalid chat job lease configuration.' using errcode = '22023';
  end if;

  select * into job
  from public.chat_jobs
  where owner_id = p_owner_id and conversation_id = p_conversation_id and job_id = p_job_id
  for update;
  if not found then
    return jsonb_build_object('claimed', false, 'status', 'missing');
  end if;

  if job.status in ('completed', 'failed', 'cancelled') then
    return jsonb_build_object('claimed', false, 'status', job.status);
  end if;

  if not (
    job.status = 'queued'
    or (job.status in ('running', 'awaiting_approval') and
      (job.lease_expires_at is null or job.lease_expires_at <= now_at))
  ) then
    return jsonb_build_object('claimed', false, 'status', job.status);
  end if;

  if job.attempt_count >= p_max_attempts then
    update public.chat_jobs
      set status = 'failed',
          error = 'The chat worker stopped before the job completed.',
          completed_at = now_at,
          lease_expires_at = null,
          lease_token = null,
          updated_at = now_at
      where owner_id = p_owner_id and conversation_id = p_conversation_id and job_id = p_job_id;
    update public.chat_messages
      set status = 'error',
          error = 'The chat worker stopped before the job completed.',
          updated_at = now_at
      where owner_id = p_owner_id and conversation_id = p_conversation_id
        and job_id = p_job_id and role = 'assistant';
    return jsonb_build_object('claimed', true, 'status', 'failed',
      'error', 'The chat worker stopped before the job completed.');
  end if;

  lease_until := now_at + make_interval(secs => p_lease_ms / 1000.0);
  update public.chat_jobs
    set status = 'running',
        started_at = coalesce(started_at, now_at),
        heartbeat_at = now_at,
        lease_expires_at = lease_until,
        lease_token = p_worker_token,
        attempt_count = attempt_count + 1,
        updated_at = now_at
    where owner_id = p_owner_id and conversation_id = p_conversation_id and job_id = p_job_id;
  return jsonb_build_object('claimed', true, 'status', 'running',
    'request', job.request, 'leaseToken', p_worker_token::text,
    'attemptCount', job.attempt_count + 1);
end;
$$;

create or replace function public.heartbeat_chat_job(
  p_owner_id uuid,
  p_conversation_id text,
  p_job_id text,
  p_worker_token uuid,
  p_lease_ms integer default 6000
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  now_at timestamptz := clock_timestamp();
  changed integer;
  current_status text;
begin
  update public.chat_jobs
    set heartbeat_at = now_at,
        lease_expires_at = now_at + make_interval(secs => p_lease_ms / 1000.0),
        updated_at = now_at
    where owner_id = p_owner_id and conversation_id = p_conversation_id and job_id = p_job_id
      and lease_token = p_worker_token
      and lease_expires_at > now_at
      and status in ('running', 'awaiting_approval');
  get diagnostics changed = row_count;
  if changed = 1 then return jsonb_build_object('active', true, 'status', 'running'); end if;
  select status into current_status from public.chat_jobs
    where owner_id = p_owner_id and conversation_id = p_conversation_id and job_id = p_job_id;
  return jsonb_build_object('active', false, 'status', coalesce(current_status, 'missing'),
    'cancelled', current_status = 'cancelled');
end;
$$;

create or replace function public.append_chat_job_events(
  p_owner_id uuid,
  p_conversation_id text,
  p_job_id text,
  p_worker_token uuid,
  p_events jsonb
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  event_row jsonb;
  inserted_count integer := 0;
begin
  if not exists (
    select 1 from public.chat_jobs
    where owner_id = p_owner_id and conversation_id = p_conversation_id and job_id = p_job_id
      and lease_token = p_worker_token and status in ('running', 'awaiting_approval')
      and lease_expires_at > clock_timestamp()
  ) then
    raise exception 'Chat job lease is no longer active.' using errcode = '40001';
  end if;
  for event_row in select value from jsonb_array_elements(p_events) loop
    insert into public.chat_job_events(owner_id, conversation_id, job_id, event_id, event_index, event)
      values (
        p_owner_id, p_conversation_id, p_job_id,
        event_row->>'eventId', (event_row->>'eventIndex')::bigint, event_row->'event'
      ) on conflict (owner_id, conversation_id, job_id, event_id) do nothing;
    if found then inserted_count := inserted_count + 1; end if;
  end loop;
  return inserted_count;
end;
$$;

create or replace function public.complete_chat_job_and_finalize_message(
  p_owner_id uuid,
  p_conversation_id text,
  p_job_id text,
  p_worker_token uuid,
  p_status text,
  p_error text default null,
  p_usage jsonb default null,
  p_final_output text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  current_job public.chat_jobs%rowtype;
  now_at timestamptz := clock_timestamp();
begin
  if p_status not in ('completed', 'failed', 'cancelled') then
    raise exception 'Invalid terminal chat job status.' using errcode = '22023';
  end if;
  select * into current_job from public.chat_jobs
    where owner_id = p_owner_id and conversation_id = p_conversation_id and job_id = p_job_id
    for update;
  if not found then return jsonb_build_object('applied', false, 'status', 'missing'); end if;
  if current_job.status in ('completed', 'failed', 'cancelled') then
    return jsonb_build_object('applied', false, 'status', current_job.status);
  end if;
  if current_job.lease_token is distinct from p_worker_token then
    return jsonb_build_object('applied', false, 'status', current_job.status, 'leaseLost', true);
  end if;
  if current_job.lease_expires_at is null or current_job.lease_expires_at <= now_at then
    return jsonb_build_object('applied', false, 'status', current_job.status, 'leaseLost', true);
  end if;

  update public.chat_jobs
    set status = p_status, error = p_error, usage = p_usage,
        final_output = p_final_output, completed_at = now_at,
        lease_expires_at = null, lease_token = null, heartbeat_at = now_at, updated_at = now_at
    where owner_id = p_owner_id and conversation_id = p_conversation_id and job_id = p_job_id;
  update public.chat_messages
    set content = case when p_final_output is null then content else p_final_output end,
        status = case p_status when 'completed' then 'complete' when 'cancelled' then 'cancelled' else 'error' end,
        error = p_error, updated_at = now_at
    where owner_id = p_owner_id and conversation_id = p_conversation_id
      and job_id = p_job_id and role = 'assistant';
  update public.chat_conversations set updated_at = now_at
    where owner_id = p_owner_id and conversation_id = p_conversation_id;
  return jsonb_build_object('applied', true, 'status', p_status);
end;
$$;

create or replace function public.cancel_chat_job_and_finalize_message(
  p_owner_id uuid,
  p_conversation_id text,
  p_job_id text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  changed integer;
  now_at timestamptz := clock_timestamp();
begin
  update public.chat_jobs
    set status = 'cancelled', completed_at = now_at, lease_expires_at = null,
        lease_token = null, heartbeat_at = now_at, updated_at = now_at
    where owner_id = p_owner_id and conversation_id = p_conversation_id and job_id = p_job_id
      and status in ('queued', 'running', 'awaiting_approval');
  get diagnostics changed = row_count;
  if changed = 1 then
    update public.chat_messages
      set status = 'cancelled', error = null, updated_at = now_at
      where owner_id = p_owner_id and conversation_id = p_conversation_id
        and job_id = p_job_id and role = 'assistant';
    update public.chat_conversations set updated_at = now_at
      where owner_id = p_owner_id and conversation_id = p_conversation_id;
  end if;
  return jsonb_build_object('applied', changed = 1, 'status', case when changed = 1 then 'cancelled' else 'not_active' end);
end;
$$;

create or replace function public.register_chat_document(
  p_owner_id uuid,
  p_conversation_id text,
  p_document jsonb,
  p_user_message_id text,
  p_job_id text,
  p_pages jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  page_total integer;
  distinct_pages integer;
  min_page integer;
  max_page integer;
  expected_pages integer := (p_document->>'pageCount')::integer;
  now_at timestamptz := clock_timestamp();
  v_document_id text := p_document->>'id';
begin
  if v_document_id is null or expected_pages is null or expected_pages < 1
    or jsonb_typeof(p_pages) <> 'array' then
    raise exception 'Document registration metadata is incomplete.' using errcode = '22023';
  end if;
  insert into public.chat_conversations(owner_id, conversation_id, title, updated_at)
    values (p_owner_id, p_conversation_id, 'New conversation', now_at)
    on conflict (owner_id, conversation_id) do update set updated_at = excluded.updated_at;
  insert into public.chat_documents(
    owner_id, conversation_id, document_id, user_message_id, job_id, storage_path,
    filename, content_type, size, page_count, token_estimate, has_images, image_count,
    analyzed_image_count, image_analyses, project_id, revision_id, parent_revision_id,
    origin, editable, source_completeness, status
  ) values (
    p_owner_id, p_conversation_id, v_document_id, p_user_message_id, p_job_id,
    p_owner_id::text || '/' || p_conversation_id || '/' || v_document_id ||
      case when p_document->>'contentType' = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' then '.docx' else '.pdf' end,
    p_document->>'name', p_document->>'contentType', (p_document->>'size')::bigint,
    expected_pages, (p_document->>'tokenEstimate')::integer,
    coalesce((p_document->>'hasImages')::boolean, false), coalesce((p_document->>'imageCount')::integer, 0),
    coalesce((p_document->>'analyzedImageCount')::integer, 0), coalesce(p_document->'imageAnalyses', '[]'::jsonb),
    p_document->>'projectId', p_document->>'revisionId', p_document->>'parentRevisionId',
    p_document->>'origin', coalesce((p_document->>'editable')::boolean, false),
    p_document->>'sourceCompleteness', 'processing'
  ) on conflict (owner_id, conversation_id, document_id) do update set
    user_message_id = excluded.user_message_id, job_id = excluded.job_id,
    filename = excluded.filename, content_type = excluded.content_type, size = excluded.size,
    page_count = excluded.page_count, token_estimate = excluded.token_estimate,
    has_images = excluded.has_images, image_count = excluded.image_count,
    analyzed_image_count = excluded.analyzed_image_count, image_analyses = excluded.image_analyses,
    project_id = excluded.project_id, revision_id = excluded.revision_id,
    parent_revision_id = excluded.parent_revision_id, origin = excluded.origin,
    editable = excluded.editable, source_completeness = excluded.source_completeness,
    status = 'processing';
  delete from public.chat_document_pages
    where owner_id = p_owner_id and conversation_id = p_conversation_id and document_id = v_document_id;
  insert into public.chat_document_pages(owner_id, conversation_id, document_id, page_number, text, extraction_method, failure)
    select p_owner_id, p_conversation_id, v_document_id,
      (page->>'pageNumber')::integer, coalesce(page->>'text', ''), coalesce(page->>'extractionMethod', 'native'), page->'failure'
    from jsonb_array_elements(p_pages) as pages(page);
  select count(*), count(distinct page_number), min(page_number), max(page_number)
    into page_total, distinct_pages, min_page, max_page
    from public.chat_document_pages
    where owner_id = p_owner_id and conversation_id = p_conversation_id and document_id = v_document_id;
  if page_total <> expected_pages or distinct_pages <> expected_pages or min_page <> 1 or max_page <> expected_pages then
    raise exception 'Document page registration is incomplete.' using errcode = '22023';
  end if;
  update public.chat_documents set status = 'complete'
    where owner_id = p_owner_id and conversation_id = p_conversation_id and document_id = v_document_id;
  return jsonb_build_object('documentId', v_document_id, 'status', 'complete');
end;
$$;

revoke all on function public.submit_and_claim_chat_job(uuid, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.submit_and_claim_chat_job(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.claim_chat_job(uuid, text, text, uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.heartbeat_chat_job(uuid, text, text, uuid, integer) from public, anon, authenticated;
revoke all on function public.append_chat_job_events(uuid, text, text, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.complete_chat_job_and_finalize_message(uuid, text, text, uuid, text, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.cancel_chat_job_and_finalize_message(uuid, text, text) from public, anon, authenticated;
revoke all on function public.register_chat_document(uuid, text, jsonb, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.submit_and_claim_chat_job(uuid, jsonb, jsonb) to service_role;
grant execute on function public.submit_and_claim_chat_job(uuid, jsonb) to service_role;
grant execute on function public.claim_chat_job(uuid, text, text, uuid, integer, integer) to service_role;
grant execute on function public.heartbeat_chat_job(uuid, text, text, uuid, integer) to service_role;
grant execute on function public.append_chat_job_events(uuid, text, text, uuid, jsonb) to service_role;
grant execute on function public.complete_chat_job_and_finalize_message(uuid, text, text, uuid, text, text, jsonb, text) to service_role;
grant execute on function public.cancel_chat_job_and_finalize_message(uuid, text, text) to service_role;
grant execute on function public.register_chat_document(uuid, text, jsonb, text, text, jsonb) to service_role;
