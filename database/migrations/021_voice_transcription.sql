alter table public.chat_usage_records
  drop constraint if exists chat_usage_records_request_kind_check;

alter table public.chat_usage_records
  add constraint chat_usage_records_request_kind_check
  check (request_kind in ('chat','title','reasoning_summary','image_analysis','image_text_analysis','image_visual_analysis','image_followup','chat_summary','chat_recall','dreaming','todo_planner','deep_research','subagent','automation','context_router','voice_transcription'));

alter table public.chat_usage_outbox
  drop constraint if exists chat_usage_outbox_request_kind_check;

alter table public.chat_usage_outbox
  add constraint chat_usage_outbox_request_kind_check
  check (request_kind in ('chat','title','reasoning_summary','image_analysis','image_text_analysis','image_visual_analysis','image_followup','chat_summary','chat_recall','dreaming','todo_planner','deep_research','subagent','automation','context_router','voice_transcription'));
