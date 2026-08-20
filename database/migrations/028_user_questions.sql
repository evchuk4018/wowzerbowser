-- Homelab opencode + ask_user escalation: pending questions with Discord delivery.

alter table public.chat_jobs drop constraint if exists chat_jobs_status_check;
alter table public.chat_jobs add constraint chat_jobs_status_check check (status in ('queued','running','awaiting_approval','awaiting_input','completed','failed','cancelled'));

alter table public.automation_runs drop constraint if exists automation_runs_status_check;
alter table public.automation_runs add constraint automation_runs_status_check check (status in ('queued','running','notified','no_match','failed','awaiting_input','expired'));

create table if not exists public.user_questions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  source text not null check (source in ('chat','automation')),
  conversation_id text,
  chat_job_id text,
  automation_run_id uuid references public.automation_runs(id) on delete set null,
  opencode_session_id text,
  question text not null check (char_length(question) between 1 and 2000),
  context text check (context is null or char_length(context) <= 4000),
  options jsonb,
  status text not null default 'pending' check (status in ('pending','answered','expired')),
  answer text check (answer is null or char_length(answer) <= 4000),
  expires_at timestamptz,
  answered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists user_questions_owner_pending on public.user_questions(owner_id, created_at) where status='pending';
create index if not exists user_questions_owner_conversation on public.user_questions(owner_id, conversation_id, created_at);
create index if not exists user_questions_expires_at on public.user_questions(expires_at) where status='pending' and expires_at is not null;

create table if not exists public.discord_user_question_notifications (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  user_question_id uuid not null references public.user_questions(id) on delete cascade,
  question text not null,
  context text,
  conversation_id text,
  status text not null default 'pending' check (status in ('pending','delivering','delivered')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  discord_channel_id text,
  discord_message_id text,
  delivered_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_id, user_question_id)
);
create index if not exists discord_user_question_notifications_pending on public.discord_user_question_notifications(owner_id, next_attempt_at) where status='pending';
create index if not exists discord_user_question_notifications_delivering on public.discord_user_question_notifications(owner_id, lease_expires_at) where status='delivering';

create or replace function public.claim_discord_user_question_notifications(p_owner_id uuid, p_limit integer default 10)
returns setof public.discord_user_question_notifications language sql set search_path=public as $$
  update public.discord_user_question_notifications set status='delivering',attempt_count=attempt_count+1,lease_expires_at=now()+interval '2 minutes',updated_at=now()
  where id in (select id from public.discord_user_question_notifications where owner_id=p_owner_id and ((status='pending' and next_attempt_at<=now()) or (status='delivering' and lease_expires_at<now())) order by created_at limit greatest(0,least(p_limit,25)) for update skip locked) returning *;
$$;

drop function if exists public.claim_due_automations(integer);
create or replace function public.claim_due_automations(p_owner_id uuid, p_limit integer default 4, p_lease_ms integer default 300000)
returns setof public.automation_runs language plpgsql set search_path=public as $$
declare candidate public.automations%rowtype; claimed public.automation_runs%rowtype; lease_until timestamptz;
begin
  if p_lease_ms < 60000 or p_lease_ms > 3600000 then raise exception 'Invalid automation lease.' using errcode='22023'; end if;
  lease_until := now() + make_interval(secs => p_lease_ms / 1000.0);
  for claimed in update public.automation_runs set status='running',attempt_count=attempt_count+1,lease_expires_at=lease_until,updated_at=now()
   where id in (select id from public.automation_runs where owner_id=p_owner_id and status='running' and lease_expires_at<now() order by scheduled_for limit greatest(0,least(p_limit,8)) for update skip locked) returning * loop
    return next claimed; p_limit:=p_limit-1;
  end loop;
  if p_limit<=0 then return; end if;
  for candidate in select * from public.automations where owner_id=p_owner_id and status='active' and deleted_at is null and next_run_at<=now() order by next_run_at limit greatest(0,least(p_limit,8)) for update skip locked loop
    insert into public.automation_runs(owner_id,automation_id,scheduled_for,status,attempt_count,lease_expires_at) values(candidate.owner_id,candidate.id,candidate.next_run_at,'running',1,lease_until)
      on conflict(automation_id,scheduled_for) do update set status='running',attempt_count=public.automation_runs.attempt_count+1,lease_expires_at=lease_until,updated_at=now() returning * into claimed;
    update public.automations set next_run_at=null,last_run_at=claimed.scheduled_for,updated_at=now() where id=candidate.id;
    return next claimed;
  end loop;
end;
$$;

create or replace function public.heartbeat_automation_run(p_owner_id uuid, p_run_id uuid, p_lease_token uuid, p_lease_ms integer default 300000)
returns boolean language plpgsql set search_path=public as $$
declare changed integer; now_at timestamptz := clock_timestamp();
begin
  update public.automation_runs set heartbeat_at=now_at, lease_expires_at=now_at+make_interval(secs => p_lease_ms/1000.0), updated_at=now_at
   where owner_id=p_owner_id and id=p_run_id and lease_token=p_lease_token and lease_expires_at > now_at and status='running';
  get diagnostics changed = row_count;
  return changed=1;
end;
$$;
