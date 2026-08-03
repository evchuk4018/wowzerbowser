-- The background worker is the only scheduler. These leases make a second
-- accidental worker safe and prevent an old worker from finishing a claim
-- after PostgreSQL has handed the same persisted run to a recovery worker.

alter table public.automation_runs
  add column if not exists lease_token uuid;

create index if not exists automations_owner_due
  on public.automations(owner_id, next_run_at, id)
  where status = 'active' and deleted_at is null and next_run_at is not null;

create index if not exists automation_runs_owner_recovery
  on public.automation_runs(owner_id, status, lease_expires_at, scheduled_for);

create or replace function public.claim_due_automations(
  p_owner_id uuid,
  p_limit integer default 4,
  p_lease_ms integer default 900000
)
returns setof public.automation_runs
language plpgsql
set search_path = public
as $$
declare
  candidate public.automations%rowtype;
  claimed public.automation_runs%rowtype;
  now_at timestamptz := clock_timestamp();
  lease_until timestamptz;
begin
  p_limit := greatest(0, least(coalesce(p_limit, 4), 4));
  if p_lease_ms < 60000 or p_lease_ms > 3600000 then
    raise exception 'Invalid automation lease configuration.' using errcode = '22023';
  end if;
  if p_limit = 0 then return; end if;
  lease_until := now_at + make_interval(secs => p_lease_ms / 1000.0);

  -- A paused or deleted automation must never be recovered into another
  -- provider execution. Its abandoned run is recorded as a terminal failure.
  update public.automation_runs runs
     set status = 'failed',
         error = 'Automation is no longer active.',
         lease_expires_at = null,
         lease_token = null,
         completed_at = now_at,
         updated_at = now_at
    from public.automations automations
   where runs.owner_id = p_owner_id
     and runs.automation_id = automations.id
     and (
       runs.status = 'queued'
       or (runs.status = 'running' and (runs.lease_expires_at is null or runs.lease_expires_at <= now_at))
     )
     and (automations.status <> 'active' or automations.deleted_at is not null);

  -- Reclaim only active runs. FOR UPDATE SKIP LOCKED is the duplicate-run
  -- boundary for two worker processes polling at the same time.
  for claimed in
    update public.automation_runs runs
       set status = 'running',
           attempt_count = runs.attempt_count + 1,
           lease_expires_at = lease_until,
           lease_token = gen_random_uuid(),
           updated_at = now_at
     where runs.id in (
       select candidates.id
         from public.automation_runs candidates
         join public.automations automations on automations.id = candidates.automation_id
        where candidates.owner_id = p_owner_id
          and (
            candidates.status = 'queued'
            or (candidates.status = 'running' and (candidates.lease_expires_at is null or candidates.lease_expires_at <= now_at))
          )
          and automations.owner_id = p_owner_id
          and automations.status = 'active'
          and automations.deleted_at is null
        order by candidates.scheduled_for, candidates.id
        for update of candidates skip locked
        limit p_limit
     )
     returning runs.*
  loop
    return next claimed;
    p_limit := p_limit - 1;
  end loop;

  if p_limit <= 0 then return; end if;

  for candidate in
    select *
      from public.automations
     where owner_id = p_owner_id
       and status = 'active'
       and deleted_at is null
       and next_run_at is not null
       and next_run_at <= now_at
     order by next_run_at, id
     for update skip locked
     limit p_limit
  loop
    insert into public.automation_runs(
      owner_id, automation_id, scheduled_for, status, attempt_count,
      lease_expires_at, lease_token
    ) values (
      candidate.owner_id, candidate.id, candidate.next_run_at, 'running', 1,
      lease_until, gen_random_uuid()
    )
    on conflict (automation_id, scheduled_for) do nothing
    returning * into claimed;

    if not found then
      -- A terminal run already owns this exact occurrence. Do not execute it
      -- twice; the normal finisher will have advanced next_run_at.
      continue;
    end if;

    update public.automations
       set next_run_at = null,
           last_run_at = claimed.scheduled_for,
           updated_at = now_at
     where id = candidate.id
       and owner_id = p_owner_id
       and next_run_at = candidate.next_run_at;
    return next claimed;
  end loop;
end;
$$;

create or replace function public.heartbeat_automation_run(
  p_owner_id uuid,
  p_run_id uuid,
  p_lease_token uuid,
  p_lease_ms integer default 900000
)
returns boolean
language sql
set search_path = public
as $$
  update public.automation_runs
     set lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_ms / 1000.0),
         updated_at = clock_timestamp()
   where owner_id = p_owner_id
     and id = p_run_id
     and status = 'running'
     and lease_token = p_lease_token
     and lease_expires_at > clock_timestamp()
  returning true;
$$;

create or replace function public.claim_user_dreaming_run(p_owner_id uuid)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_run_id uuid;
  v_job_count integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text, 701));
  update public.dreaming_runs
     set status = 'queued', lease_expires_at = null, updated_at = clock_timestamp()
   where owner_id = p_owner_id
     and status = 'running'
     and (lease_expires_at is null or lease_expires_at <= clock_timestamp());

  select id into v_run_id
    from public.dreaming_runs
   where owner_id = p_owner_id and status = 'queued'
   order by created_at
   limit 1;
  if v_run_id is not null then return v_run_id; end if;

  select count(*) into v_job_count
    from (
      select completed.job_id
        from public.dreaming_completed_jobs completed
       where completed.owner_id = p_owner_id
         and not exists (
           select 1 from public.dreaming_run_sources sources
            where sources.owner_id = completed.owner_id and sources.job_id = completed.job_id
         )
       order by completed.sequence
       limit 3
    ) candidates;
  if v_job_count < 3 then return null; end if;

  insert into public.dreaming_runs(owner_id, status)
    values (p_owner_id, 'queued')
    returning id into v_run_id;
  insert into public.dreaming_run_sources(run_id, owner_id, job_id, sequence, conversation_id, completed_at)
    select v_run_id, completed.owner_id, completed.job_id, completed.sequence, completed.conversation_id, completed.completed_at
      from public.dreaming_completed_jobs completed
     where completed.owner_id = p_owner_id
       and not exists (
         select 1 from public.dreaming_run_sources sources
          where sources.owner_id = completed.owner_id and sources.job_id = completed.job_id
       )
     order by completed.sequence
     limit 3;
  return v_run_id;
end;
$$;
