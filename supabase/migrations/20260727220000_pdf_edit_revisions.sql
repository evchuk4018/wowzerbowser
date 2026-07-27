alter table public.chat_documents add column if not exists parent_revision_id text;
alter table public.chat_documents add column if not exists editable boolean not null default false;
alter table public.chat_documents add column if not exists source_completeness text check (source_completeness in ('complete','entrypoint-only'));
