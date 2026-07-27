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

  insert into public.chat_conversations(owner_id, conversation_id, title, updated_at)
    values (p_owner_id, v_conversation_id, 'New conversation', now_at)
    on conflict (owner_id, conversation_id) do update set updated_at = excluded.updated_at;
  insert into public.chat_turns(owner_id, conversation_id, turn_id, position, active_version, updated_at)
    values (p_owner_id, v_conversation_id, persistence->>'turnId', (persistence->>'turnIndex')::integer,
      (persistence->>'versionIndex')::integer, now_at)
    on conflict (owner_id, conversation_id, turn_id) do update
      set active_version = excluded.active_version, updated_at = excluded.updated_at;
  insert into public.chat_message_versions(owner_id, conversation_id, turn_id, version_id, version_index)
    values (p_owner_id, v_conversation_id, persistence->>'turnId', persistence->>'versionId',
      (persistence->>'versionIndex')::integer) on conflict do nothing;
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
