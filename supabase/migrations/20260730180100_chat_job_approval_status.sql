alter table public.chat_jobs drop constraint if exists chat_jobs_status_check;
alter table public.chat_jobs add constraint chat_jobs_status_check check (status in ('queued','running','awaiting_approval','completed','failed','cancelled'));
