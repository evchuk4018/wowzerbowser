alter table public.chat_user_preferences
  add column if not exists automation_model jsonb;

create table if not exists public.automations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  name text not null check (char_length(name) between 1 and 100),
  kind text not null check (kind in ('report', 'live_check')),
  instructions text not null check (char_length(instructions) between 1 and 12000),
  schedule jsonb not null,
  time_zone text not null,
  status text not null default 'active' check (status in ('active', 'paused')),
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_outcome text check (last_outcome in ('notified', 'no_match', 'failed')),
  last_error text,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.automation_runs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  automation_id uuid not null references public.automations(id),
  scheduled_for timestamptz not null,
  status text not null default 'queued' check (status in ('queued','running','notified','no_match','failed')),
  attempt_count integer not null default 0,
  lease_expires_at timestamptz,
  matched boolean,
  title text,
  output text,
  error text,
  conversation_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (automation_id, scheduled_for)
);

create index if not exists automations_due
  on public.automations(next_run_at) where status = 'active' and deleted_at is null;
create index if not exists automations_owner_updated
  on public.automations(owner_id, updated_at desc) where deleted_at is null;
create index if not exists automation_runs_recovery
  on public.automation_runs(status, lease_expires_at);

alter table public.automations enable row level security;
alter table public.automation_runs enable row level security;

create or replace function public.claim_due_automations(p_limit integer default 4)
returns setof public.automation_runs
language plpgsql security definer set search_path = public
as $$
declare
  candidate public.automations%rowtype;
  claimed public.automation_runs%rowtype;
begin
  for claimed in
    update public.automation_runs
       set status = 'running',
           attempt_count = attempt_count + 1,
           lease_expires_at = now() + interval '5 minutes',
           updated_at = now()
     where id in (
       select id from public.automation_runs
        where status = 'running' and lease_expires_at < now()
        order by scheduled_for
        for update skip locked
        limit greatest(0, least(p_limit, 8))
     )
     returning *
  loop
    return next claimed;
    p_limit := p_limit - 1;
  end loop;

  if p_limit <= 0 then return; end if;

  for candidate in
    select * from public.automations
     where status = 'active' and deleted_at is null and next_run_at <= now()
     order by next_run_at
     for update skip locked
     limit greatest(0, least(p_limit, 8))
  loop
    insert into public.automation_runs(owner_id, automation_id, scheduled_for, status, attempt_count, lease_expires_at)
      values(candidate.owner_id, candidate.id, candidate.next_run_at, 'running', 1, now() + interval '5 minutes')
      on conflict (automation_id, scheduled_for) do update
        set status = 'running',
            attempt_count = public.automation_runs.attempt_count + 1,
            lease_expires_at = now() + interval '5 minutes',
            updated_at = now()
      returning * into claimed;
    update public.automations set next_run_at = null, last_run_at = claimed.scheduled_for, updated_at = now()
      where id = candidate.id;
    return next claimed;
  end loop;
end;
$$;

revoke all on function public.claim_due_automations(integer) from public, anon, authenticated;
grant execute on function public.claim_due_automations(integer) to service_role;
-- Server/service-role access only. Configure one Supabase Cron pg_net HTTP job
-- after deployment; its URL and bearer secret belong in Supabase Vault.
