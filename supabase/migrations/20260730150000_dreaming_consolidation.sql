alter table public.user_memory_profiles
  add column if not exists dreaming_cycle_count integer not null default 0,
  add column if not exists consolidated_prompt text not null default '';

create table if not exists public.dreaming_consolidations (
  owner_id uuid not null references public.user_memory_profiles(owner_id) on delete cascade,
  cycle_number integer not null check (cycle_number > 0),
  source_run_ids uuid[] not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed')),
  prompt text not null default '',
  model text,
  last_error text,
  lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (owner_id, cycle_number)
);

create table if not exists public.dreaming_cycle_runs (
  owner_id uuid not null references public.user_memory_profiles(owner_id) on delete cascade,
  run_id uuid not null references public.dreaming_runs(id) on delete cascade,
  cycle_number integer not null check (cycle_number > 0),
  created_at timestamptz not null default now(),
  primary key (owner_id, run_id)
);

alter table public.dreaming_consolidations enable row level security;
alter table public.dreaming_cycle_runs enable row level security;

create or replace function public.record_dreaming_cycle(p_owner_id uuid, p_run_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
  v_cycle integer;
  v_run_ids uuid[];
begin
  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text, 702));
  insert into public.user_memory_profiles(owner_id) values (p_owner_id)
    on conflict (owner_id) do nothing;
  insert into public.dreaming_cycle_runs(owner_id, run_id, cycle_number)
    select p_owner_id, p_run_id, profiles.dreaming_cycle_count + 1
    from public.user_memory_profiles profiles
    where profiles.owner_id = p_owner_id
    on conflict (owner_id, run_id) do nothing;
  if not found then return null; end if;
  update public.user_memory_profiles
    set dreaming_cycle_count = dreaming_cycle_count + 1, updated_at = now()
    where owner_id = p_owner_id
    returning dreaming_cycle_count into v_count;
  if mod(v_count, 5) <> 0 then return null; end if;
  v_cycle := v_count / 5;
  select array_agg(cycle_runs.run_id order by cycle_runs.created_at)
    into v_run_ids
    from public.dreaming_cycle_runs cycle_runs
    where cycle_runs.owner_id = p_owner_id and cycle_runs.cycle_number = v_cycle;
  insert into public.dreaming_consolidations(owner_id, cycle_number, source_run_ids)
    values (p_owner_id, v_cycle, coalesce(v_run_ids, '{}'::uuid[]))
    on conflict (owner_id, cycle_number) do nothing;
  return v_cycle;
end;
$$;

revoke all on function public.record_dreaming_cycle(uuid, uuid) from public, anon, authenticated;
grant execute on function public.record_dreaming_cycle(uuid, uuid) to service_role;
