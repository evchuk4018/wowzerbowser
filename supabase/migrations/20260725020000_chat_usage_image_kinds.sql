alter table public.chat_usage_records drop constraint if exists chat_usage_records_request_kind_check;
alter table public.chat_usage_records
  add constraint chat_usage_records_request_kind_check
  check (request_kind in ('chat', 'title', 'image_text_analysis', 'image_visual_analysis', 'image_followup'));

alter table public.chat_usage_outbox drop constraint if exists chat_usage_outbox_request_kind_check;
alter table public.chat_usage_outbox
  add constraint chat_usage_outbox_request_kind_check
  check (request_kind in ('chat', 'title', 'image_text_analysis', 'image_visual_analysis', 'image_followup'));

alter table public.chat_usage_records add column if not exists conversation_id text;
alter table public.chat_usage_records add column if not exists job_id text;
alter table public.chat_usage_outbox add column if not exists conversation_id text;
alter table public.chat_usage_outbox add column if not exists job_id text;
