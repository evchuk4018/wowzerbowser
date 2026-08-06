alter table public.chat_model_pricing
  alter column input_usd_per_million drop not null,
  alter column output_usd_per_million drop not null;

alter table public.chat_model_pricing
  add column if not exists request_usd numeric(18, 9),
  add column if not exists reasoning_usd_per_million numeric(18, 9);

alter table public.chat_usage_records
  add column if not exists request_usd numeric(18, 9),
  add column if not exists reasoning_usd_per_million numeric(18, 9);

alter table public.chat_usage_outbox
  add column if not exists request_usd numeric(18, 9),
  add column if not exists reasoning_usd_per_million numeric(18, 9);

create index if not exists chat_usage_records_prompt_cost
  on public.chat_usage_records(owner_id, conversation_id, job_id, recorded_at desc)
  where conversation_id is not null and job_id is not null;

create index if not exists chat_usage_outbox_prompt_cost
  on public.chat_usage_outbox(owner_id, conversation_id, job_id, id)
  where conversation_id is not null and job_id is not null;

create or replace function public.refresh_chat_job_cost(
  p_owner_id uuid,
  p_conversation_id text,
  p_job_id text
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  usage_count bigint;
  total_cost numeric;
  has_unpriced boolean;
  has_estimated boolean;
  run_cost jsonb;
begin
  select count(*),
         coalesce(sum(cost_usd), 0),
         coalesce(bool_or(unpriced or cost_usd is null), false),
         coalesce(bool_or(usage_source = 'estimated'), false)
    into usage_count, total_cost, has_unpriced, has_estimated
    from public.chat_usage_records
   where owner_id = p_owner_id
     and conversation_id = p_conversation_id
     and job_id = p_job_id
     and request_kind <> 'dreaming';

  if usage_count = 0 then
    return jsonb_build_object('updated', false);
  end if;

  if has_unpriced then
    run_cost := jsonb_build_object('costUsd', null, 'source', 'unpriced');
  else
    run_cost := jsonb_build_object(
      'costUsd', total_cost,
      'source', case when has_estimated then 'estimated' else 'exact' end
    );
  end if;

  update public.chat_jobs
     set provider_metrics = jsonb_set(coalesce(provider_metrics, '{}'::jsonb), '{runCost}', run_cost, true),
         updated_at = clock_timestamp()
   where owner_id = p_owner_id
     and conversation_id = p_conversation_id
     and job_id = p_job_id;

  update public.chat_messages
     set stream_metrics = jsonb_set(coalesce(stream_metrics, '{}'::jsonb), '{runCost}', run_cost, true),
         updated_at = clock_timestamp()
   where owner_id = p_owner_id
     and conversation_id = p_conversation_id
     and job_id = p_job_id
     and role = 'assistant';

  return jsonb_build_object('updated', true, 'runCost', run_cost);
end;
$$;
