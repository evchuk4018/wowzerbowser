alter table public.chat_message_versions
  add column if not exists parent_version_id text;

create or replace function public.submit_and_claim_chat_job(
  p_owner_id uuid,
  p_request jsonb
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
    or persistence is null or user_message->>'role' <> 'user' then
    raise exception 'Chat persistence metadata is incomplete.' using errcode = '22023';
  end if;

  select * into existing_job from public.chat_jobs
    where owner_id = p_owner_id and chat_jobs.conversation_id = v_conversation_id
      and chat_jobs.idempotency_key = v_idempotency_key;
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
      coalesce(user_message->'attachments', '[]'::jsonb), coalesce(user_message->'documents', '[]'::jsonb),
      '[]'::jsonb, '[]'::jsonb, null, 0, now_at) on conflict do nothing;
  insert into public.chat_messages(owner_id, conversation_id, turn_id, version_id, message_id, role,
      content, reasoning, activities, artifacts, thinking_enabled, status, job_id, last_sequence, updated_at)
    values (p_owner_id, v_conversation_id, persistence->>'turnId', persistence->>'versionId',
      persistence->>'assistantMessageId', 'assistant', '', '', '[]'::jsonb, '[]'::jsonb,
      coalesce((p_request->>'thinking')::boolean, false), 'streaming', v_requested_job_id, 0, now_at)
    on conflict do nothing;
  insert into public.chat_jobs(owner_id, conversation_id, job_id, idempotency_key, request, status,
      started_at, updated_at)
    values (p_owner_id, v_conversation_id, v_requested_job_id, v_idempotency_key, p_request, 'running', now_at, now_at);

  return jsonb_build_object('jobId', v_requested_job_id, 'status', 'running',
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

revoke all on function public.submit_and_claim_chat_job(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.submit_and_claim_chat_job(uuid, jsonb) to service_role;
