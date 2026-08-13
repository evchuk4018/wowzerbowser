-- One-off reminders share the durable automation lease and delivery pipeline,
-- but retain completed/cancelled rows so users can inspect their lifecycle.

alter table public.automations drop constraint if exists automations_kind_check;
alter table public.automations
  add constraint automations_kind_check check (kind in ('report','live_check','reminder'));

alter table public.automations drop constraint if exists automations_status_check;
alter table public.automations
  add constraint automations_status_check check (status in ('active','paused','completed','cancelled'));

create index if not exists reminders_owner_updated
  on public.automations(owner_id, updated_at desc)
  where kind = 'reminder' and deleted_at is null;

create index if not exists reminders_due
  on public.automations(owner_id, next_run_at, id)
  where kind = 'reminder' and status = 'active' and deleted_at is null and next_run_at is not null;
