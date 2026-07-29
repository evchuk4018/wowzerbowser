-- This is a new migration on purpose. Do not rely on edits to the already
-- applied 20260728200000_user_memory_dreaming migration being replayed.

alter table public.chat_summary_jobs
  add column if not exists result_summary text;

alter table public.dreaming_runs
  add column if not exists model text,
  add column if not exists action_plan jsonb,
  add column if not exists last_error text;

alter table public.dreaming_applied_actions
  add column if not exists action_index integer,
  add column if not exists completed_at timestamptz default now();

create index if not exists dreaming_runs_reliability_status
  on public.dreaming_runs(owner_id, status, updated_at desc);
