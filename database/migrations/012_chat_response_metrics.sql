alter table public.chat_jobs
  add column if not exists provider_metrics jsonb;

alter table public.chat_messages
  add column if not exists stream_metrics jsonb;

create or replace function public.complete_chat_job_and_finalize_message(
  p_owner_id uuid,
  p_conversation_id text,
  p_job_id text,
  p_worker_token uuid,
  p_status text,
  p_error text,
  p_usage jsonb,
  p_final_output text,
  p_provider_metrics jsonb
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  current_job public.chat_jobs%rowtype;
  now_at timestamptz := clock_timestamp();
begin
  if p_status not in ('completed','failed','cancelled') then
    raise exception 'Invalid terminal chat job status.' using errcode='22023';
  end if;
  select * into current_job
    from public.chat_jobs
    where owner_id=p_owner_id and conversation_id=p_conversation_id and job_id=p_job_id
    for update;
  if not found then return jsonb_build_object('applied',false,'status','missing'); end if;
  if current_job.status in ('completed','failed','cancelled') then
    return jsonb_build_object('applied',false,'status',current_job.status);
  end if;
  if current_job.lease_token is distinct from p_worker_token
    or current_job.lease_expires_at is null
    or current_job.lease_expires_at <= now_at then
    return jsonb_build_object('applied',false,'status',current_job.status,'leaseLost',true);
  end if;

  update public.chat_jobs
    set status=p_status,
        error=p_error,
        usage=p_usage,
        provider_metrics=p_provider_metrics,
        final_output=p_final_output,
        completed_at=now_at,
        lease_expires_at=null,
        lease_token=null,
        heartbeat_at=now_at,
        updated_at=now_at
    where owner_id=p_owner_id and conversation_id=p_conversation_id and job_id=p_job_id;
  update public.chat_messages
    set content=case when p_final_output is null then content else p_final_output end,
        stream_metrics=case when p_provider_metrics is null then stream_metrics else p_provider_metrics end,
        status=case p_status when 'completed' then 'complete' when 'cancelled' then 'cancelled' else 'error' end,
        error=p_error,
        updated_at=now_at
    where owner_id=p_owner_id and conversation_id=p_conversation_id and job_id=p_job_id and role='assistant';
  update public.chat_conversations set updated_at=now_at
    where owner_id=p_owner_id and conversation_id=p_conversation_id;
  return jsonb_build_object('applied',true,'status',p_status);
end;
$$;
