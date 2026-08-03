-- Durable work owned by the PostgreSQL-backed background worker.  The
-- notification calls below are only wake-up hints; queue state and claims
-- remain durable in these tables and their atomic functions.

create table if not exists public.document_processing_jobs (
  owner_id uuid not null,
  conversation_id text not null,
  job_id text not null,
  idempotency_key text not null,
  document_id text not null,
  storage_object_id uuid not null references public.app_storage_objects(object_id) on delete cascade,
  request jsonb not null,
  status text not null check (status in ('queued','running','completed','failed','cancelled')),
  error text,
  progress jsonb not null default '{}'::jsonb,
  result jsonb,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null default now(),
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  lease_token uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  primary key (owner_id, conversation_id, job_id),
  unique (owner_id, conversation_id, idempotency_key),
  foreign key (owner_id, conversation_id)
    references public.chat_conversations(owner_id, conversation_id) on delete cascade
);

create index if not exists document_processing_jobs_due
  on public.document_processing_jobs(owner_id, status, next_attempt_at, created_at);
create index if not exists document_processing_jobs_document
  on public.document_processing_jobs(owner_id, conversation_id, document_id, created_at desc);

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
    (job.status in ('running','awaiting_approval') and (job.lease_expires_at is null or job.lease_expires_at <= now_at))) then
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
       or (status in ('running','awaiting_approval') and (lease_expires_at is null or lease_expires_at <= clock_timestamp()))
     )
   order by created_at
   limit 1
   for update skip locked;
  if not found then return jsonb_build_object('claimed', false, 'status', 'empty'); end if;
  claimed := public.claim_chat_job(p_owner_id, candidate.conversation_id, candidate.job_id, p_worker_token, p_lease_ms, p_max_attempts);
  return claimed || jsonb_build_object('conversationId', candidate.conversation_id, 'jobId', candidate.job_id);
end;
$$;

create or replace function public.enqueue_document_processing_job(
  p_owner_id uuid, p_conversation_id text, p_job_id text, p_idempotency_key text,
  p_document_id text, p_storage_object_id uuid, p_request jsonb
) returns jsonb
language plpgsql set search_path = public as $$
declare
  existing public.document_processing_jobs%rowtype;
begin
  select * into existing from public.document_processing_jobs
   where owner_id=p_owner_id and conversation_id=p_conversation_id and idempotency_key=p_idempotency_key
   for update;
  if found then
    return jsonb_build_object('jobId', existing.job_id, 'documentId', existing.document_id,
      'status', existing.status, 'error', existing.error, 'progress', existing.progress, 'result', existing.result, 'resumed', true);
  end if;
  insert into public.document_processing_jobs(
    owner_id, conversation_id, job_id, idempotency_key, document_id, storage_object_id, request, status, updated_at
  ) values (
    p_owner_id, p_conversation_id, p_job_id, p_idempotency_key, p_document_id, p_storage_object_id, p_request, 'queued', clock_timestamp()
  );
  perform pg_notify('wowzerbowser_jobs', jsonb_build_object('kind','document','ownerId',p_owner_id::text,'conversationId',p_conversation_id,'jobId',p_job_id)::text);
  return jsonb_build_object('jobId', p_job_id, 'documentId', p_document_id, 'status', 'queued',
    'error', null, 'progress', '{}'::jsonb, 'result', null, 'resumed', false);
exception when unique_violation then
  select * into existing from public.document_processing_jobs
   where owner_id=p_owner_id and conversation_id=p_conversation_id and idempotency_key=p_idempotency_key;
  if found then
    return jsonb_build_object('jobId', existing.job_id, 'documentId', existing.document_id,
      'status', existing.status, 'error', existing.error, 'progress', existing.progress, 'result', existing.result, 'resumed', true);
  end if;
  raise;
end;
$$;

create or replace function public.claim_next_document_processing_job(
  p_owner_id uuid, p_worker_token uuid, p_lease_ms integer default 15000,
  p_max_attempts integer default 3
) returns jsonb
language plpgsql set search_path = public as $$
declare
  job public.document_processing_jobs%rowtype;
  now_at timestamptz := clock_timestamp();
  lease_until timestamptz;
begin
  if p_lease_ms < 1000 or p_max_attempts < 1 then
    raise exception 'Invalid document job lease configuration.' using errcode = '22023';
  end if;
  select * into job from public.document_processing_jobs
   where owner_id=p_owner_id and next_attempt_at <= now_at and (
     status='queued' or (status='running' and (lease_expires_at is null or lease_expires_at <= now_at))
   )
   order by created_at
   limit 1
   for update skip locked;
  if not found then return jsonb_build_object('claimed', false, 'status', 'empty'); end if;
  if job.attempt_count >= p_max_attempts then
    update public.document_processing_jobs set status='failed', error='The document worker stopped before processing completed.', completed_at=now_at,
      lease_expires_at=null, lease_token=null, updated_at=now_at
     where owner_id=job.owner_id and conversation_id=job.conversation_id and job_id=job.job_id;
    return jsonb_build_object('claimed', true, 'status', 'failed', 'conversationId', job.conversation_id, 'jobId', job.job_id,
      'documentId', job.document_id, 'error', 'The document worker stopped before processing completed.');
  end if;
  lease_until := now_at + make_interval(secs => p_lease_ms / 1000.0);
  update public.document_processing_jobs set status='running', started_at=coalesce(started_at,now_at), heartbeat_at=now_at,
    lease_expires_at=lease_until, lease_token=p_worker_token, attempt_count=attempt_count+1, updated_at=now_at
   where owner_id=job.owner_id and conversation_id=job.conversation_id and job_id=job.job_id;
  return jsonb_build_object('claimed', true, 'status', 'running', 'conversationId', job.conversation_id, 'jobId', job.job_id,
    'documentId', job.document_id, 'storageObjectId', job.storage_object_id::text, 'request', job.request,
    'progress', job.progress, 'leaseToken', p_worker_token::text, 'attemptCount', job.attempt_count + 1);
end;
$$;

create or replace function public.heartbeat_document_processing_job(
  p_owner_id uuid, p_conversation_id text, p_job_id text, p_worker_token uuid,
  p_lease_ms integer default 15000, p_progress jsonb default null
) returns jsonb
language plpgsql set search_path = public as $$
declare changed integer; current_status text; now_at timestamptz := clock_timestamp();
begin
  update public.document_processing_jobs set heartbeat_at=now_at,
    lease_expires_at=now_at+make_interval(secs => p_lease_ms/1000.0),
    progress=coalesce(p_progress,progress), updated_at=now_at
   where owner_id=p_owner_id and conversation_id=p_conversation_id and job_id=p_job_id
     and lease_token=p_worker_token and lease_expires_at > now_at and status='running';
  get diagnostics changed = row_count;
  if changed=1 then return jsonb_build_object('active',true,'status','running'); end if;
  select status into current_status from public.document_processing_jobs
   where owner_id=p_owner_id and conversation_id=p_conversation_id and job_id=p_job_id;
  return jsonb_build_object('active',false,'status',coalesce(current_status,'missing'),'cancelled',current_status='cancelled');
end;
$$;

create or replace function public.complete_document_processing_job(
  p_owner_id uuid, p_conversation_id text, p_job_id text, p_worker_token uuid,
  p_result jsonb, p_progress jsonb default null
) returns jsonb
language plpgsql set search_path = public as $$
declare changed integer; now_at timestamptz := clock_timestamp();
begin
  update public.document_processing_jobs set status='completed', result=p_result, progress=coalesce(p_progress,progress),
    error=null, completed_at=now_at, lease_expires_at=null, lease_token=null, heartbeat_at=now_at, updated_at=now_at
   where owner_id=p_owner_id and conversation_id=p_conversation_id and job_id=p_job_id
     and lease_token=p_worker_token and lease_expires_at > now_at and status='running';
  get diagnostics changed = row_count;
  return jsonb_build_object('applied',changed=1,'status',case when changed=1 then 'completed' else 'not_active' end);
end;
$$;

create or replace function public.fail_document_processing_job(
  p_owner_id uuid, p_conversation_id text, p_job_id text, p_worker_token uuid,
  p_error text, p_retryable boolean default true, p_max_attempts integer default 3
) returns jsonb
language plpgsql set search_path = public as $$
declare job public.document_processing_jobs%rowtype; now_at timestamptz := clock_timestamp(); retry_at timestamptz;
begin
  select * into job from public.document_processing_jobs
   where owner_id=p_owner_id and conversation_id=p_conversation_id and job_id=p_job_id
     and lease_token=p_worker_token and lease_expires_at > now_at and status='running' for update;
  if not found then return jsonb_build_object('applied',false,'status','not_active'); end if;
  if p_retryable and job.attempt_count < p_max_attempts then
    retry_at := now_at + make_interval(secs => least(60, greatest(1, job.attempt_count * 2)));
    update public.document_processing_jobs set status='queued', error=p_error, next_attempt_at=retry_at,
      lease_expires_at=null, lease_token=null, heartbeat_at=now_at, updated_at=now_at where owner_id=job.owner_id and conversation_id=job.conversation_id and job_id=job.job_id;
    return jsonb_build_object('applied',true,'status','queued','retryAt',retry_at);
  end if;
  update public.document_processing_jobs set status='failed', error=p_error, completed_at=now_at,
    lease_expires_at=null, lease_token=null, heartbeat_at=now_at, updated_at=now_at where owner_id=job.owner_id and conversation_id=job.conversation_id and job_id=job.job_id;
  return jsonb_build_object('applied',true,'status','failed');
end;
$$;

create or replace function public.cancel_document_processing_job(
  p_owner_id uuid, p_conversation_id text, p_job_id text
) returns jsonb
language plpgsql set search_path = public as $$
declare changed integer; now_at timestamptz := clock_timestamp();
begin
  update public.document_processing_jobs set status='cancelled', error=null, completed_at=now_at,
    lease_expires_at=null, lease_token=null, heartbeat_at=now_at, updated_at=now_at
   where owner_id=p_owner_id and conversation_id=p_conversation_id and job_id=p_job_id
     and status in ('queued','running');
  get diagnostics changed = row_count;
  return jsonb_build_object('applied',changed=1,'status',case when changed=1 then 'cancelled' else 'not_active' end);
end;
$$;
