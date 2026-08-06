create or replace function public.claim_chat_job(
  p_owner_id uuid, p_conversation_id text, p_job_id text, p_worker_token uuid,
  p_lease_ms integer default 6000, p_max_attempts integer default 3
) returns jsonb
language plpgsql set search_path = public as $$
declare
  job public.chat_jobs%rowtype;
  now_at timestamptz := clock_timestamp();
  lease_until timestamptz;
  next_event_index bigint;
begin
  if p_lease_ms < 1000 or p_max_attempts < 1 then
    raise exception 'Invalid chat job lease configuration.' using errcode = '22023';
  end if;
  select * into job from public.chat_jobs
   where owner_id = p_owner_id and conversation_id = p_conversation_id and job_id = p_job_id for update;
  if not found then return jsonb_build_object('claimed', false, 'status', 'missing'); end if;
  if job.status in ('completed','failed','cancelled') then
    return jsonb_build_object('claimed', false, 'status', job.status);
  end if;
  if not (job.status = 'queued' or
    (job.status = 'running' and (job.lease_expires_at is null or job.lease_expires_at <= now_at))) then
    return jsonb_build_object('claimed', false, 'status', job.status);
  end if;
  if job.attempt_count >= p_max_attempts then
    update public.chat_jobs set status='failed', error='The chat worker stopped before the job completed.',
      completed_at=now_at, lease_expires_at=null, lease_token=null, updated_at=now_at
     where owner_id=p_owner_id and conversation_id=p_conversation_id and job_id=p_job_id;
    update public.chat_messages set status='error', error='The chat worker stopped before the job completed.', updated_at=now_at
     where owner_id=p_owner_id and conversation_id=p_conversation_id and job_id=p_job_id and role='assistant';
    return jsonb_build_object('claimed', true, 'status', 'failed', 'error', 'The chat worker stopped before the job completed.');
  end if;
  select coalesce(max(event_index), 0) + 1 into next_event_index
    from public.chat_job_events
   where owner_id=p_owner_id and conversation_id=p_conversation_id and job_id=p_job_id;
  lease_until := now_at + make_interval(secs => p_lease_ms / 1000.0);
  update public.chat_jobs set status='running', started_at=coalesce(started_at, now_at), heartbeat_at=now_at,
    lease_expires_at=lease_until, lease_token=p_worker_token, attempt_count=attempt_count+1, updated_at=now_at
   where owner_id=p_owner_id and conversation_id=p_conversation_id and job_id=p_job_id;
  return jsonb_build_object('claimed', true, 'status', 'running', 'request', job.request,
    'leaseToken', p_worker_token::text, 'attemptCount', job.attempt_count + 1,
    'nextEventIndex', next_event_index);
end;
$$;

create or replace function public.claim_next_chat_job(
  p_owner_id uuid, p_worker_token uuid, p_lease_ms integer default 6000,
  p_max_attempts integer default 3
) returns jsonb
language plpgsql set search_path = public as $$
declare
  candidate record;
  claimed jsonb;
begin
  select conversation_id, job_id into candidate
    from public.chat_jobs
   where owner_id = p_owner_id
     and (
       status = 'queued'
       or (status = 'running' and (lease_expires_at is null or lease_expires_at <= clock_timestamp()))
     )
   order by created_at
   limit 1
   for update skip locked;
  if not found then return jsonb_build_object('claimed', false, 'status', 'empty'); end if;
  claimed := public.claim_chat_job(p_owner_id, candidate.conversation_id, candidate.job_id, p_worker_token, p_lease_ms, p_max_attempts);
  return claimed || jsonb_build_object('conversationId', candidate.conversation_id, 'jobId', candidate.job_id);
end;
$$;
