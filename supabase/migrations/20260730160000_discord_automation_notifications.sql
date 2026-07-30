create table if not exists public.discord_automation_notifications (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  automation_run_id uuid not null references public.automation_runs(id),
  conversation_id text not null,
  title text not null check (char_length(title) between 1 and 160),
  message text not null,
  status text not null default 'pending' check (status in ('pending', 'delivering', 'delivered')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  lease_expires_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  discord_channel_id text,
  discord_message_id text,
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, automation_run_id)
);

create index if not exists discord_automation_notifications_pending
  on public.discord_automation_notifications(next_attempt_at, created_at)
  where status in ('pending', 'delivering');

alter table public.discord_automation_notifications enable row level security;

create or replace function public.claim_discord_automation_notifications(
  p_owner_id uuid,
  p_limit integer default 10
)
returns setof public.discord_automation_notifications
language sql security definer set search_path = public
as $$
  update public.discord_automation_notifications
     set status = 'delivering',
         attempt_count = attempt_count + 1,
         lease_expires_at = now() + interval '2 minutes',
         updated_at = now()
   where id in (
     select id
       from public.discord_automation_notifications
      where owner_id = p_owner_id
        and (
          (status = 'pending' and next_attempt_at <= now())
          or (status = 'delivering' and lease_expires_at < now())
        )
      order by created_at
      for update skip locked
      limit greatest(0, least(p_limit, 25))
   )
  returning *;
$$;

revoke all on function public.claim_discord_automation_notifications(uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_discord_automation_notifications(uuid, integer) to service_role;
