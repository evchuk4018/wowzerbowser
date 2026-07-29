create table if not exists public.chat_todo_lists (
  owner_id uuid not null,
  conversation_id text not null,
  revision integer not null default 0 check (revision >= 0),
  items jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, conversation_id),
  foreign key (owner_id, conversation_id) references public.chat_conversations on delete cascade
);
create index if not exists chat_todo_lists_updated on public.chat_todo_lists(owner_id, updated_at desc);
alter table public.chat_todo_lists enable row level security;
alter table public.chat_messages add column if not exists todos jsonb;

alter table public.chat_usage_records drop constraint if exists chat_usage_records_request_kind_check;
alter table public.chat_usage_records add constraint chat_usage_records_request_kind_check check (request_kind in ('chat', 'title', 'reasoning_summary', 'image_text_analysis', 'image_visual_analysis', 'image_followup', 'chat_summary', 'chat_recall', 'dreaming', 'todo_planner'));
alter table public.chat_usage_outbox drop constraint if exists chat_usage_outbox_request_kind_check;
alter table public.chat_usage_outbox add constraint chat_usage_outbox_request_kind_check check (request_kind in ('chat', 'title', 'reasoning_summary', 'image_text_analysis', 'image_visual_analysis', 'image_followup', 'chat_summary', 'chat_recall', 'dreaming', 'todo_planner'));
