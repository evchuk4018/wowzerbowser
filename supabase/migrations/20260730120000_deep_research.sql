create table if not exists public.research_page_cache (
  canonical_url text primary key,
  final_url text not null,
  content_hash text not null,
  content_type text not null,
  title text not null default '',
  markdown text not null,
  links jsonb not null default '[]'::jsonb,
  published_at timestamptz,
  etag text,
  last_modified text,
  extractor text not null,
  fetched_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists research_page_cache_hash on public.research_page_cache(content_hash);
create index if not exists research_page_cache_expiry on public.research_page_cache(expires_at);
alter table public.research_page_cache enable row level security;

alter table public.chat_usage_records drop constraint if exists chat_usage_records_request_kind_check;
alter table public.chat_usage_records add constraint chat_usage_records_request_kind_check check (
  request_kind in ('chat', 'title', 'reasoning_summary', 'image_analysis', 'image_text_analysis', 'image_visual_analysis', 'image_followup', 'chat_summary', 'chat_recall', 'dreaming', 'todo_planner', 'deep_research', 'automation')
);
alter table public.chat_usage_outbox drop constraint if exists chat_usage_outbox_request_kind_check;
alter table public.chat_usage_outbox add constraint chat_usage_outbox_request_kind_check check (
  request_kind in ('chat', 'title', 'reasoning_summary', 'image_analysis', 'image_text_analysis', 'image_visual_analysis', 'image_followup', 'chat_summary', 'chat_recall', 'dreaming', 'todo_planner', 'deep_research', 'automation')
);
