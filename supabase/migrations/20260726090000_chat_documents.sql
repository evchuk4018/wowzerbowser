insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('chat-documents', 'chat-documents', false, 26214400, array['application/pdf'])
on conflict (id) do update set public=false, file_size_limit=26214400, allowed_mime_types=array['application/pdf'];

alter table public.chat_messages add column if not exists documents jsonb not null default '[]'::jsonb;

create table if not exists public.chat_documents (
 owner_id uuid not null references auth.users(id) on delete cascade,
 conversation_id text not null,
 document_id text not null,
 user_message_id text,
 job_id text,
 storage_path text not null unique,
 filename text not null,
 content_type text not null check (content_type='application/pdf'),
 size bigint not null check (size between 1 and 26214400),
 page_count integer not null check (page_count > 0),
 token_estimate integer not null check (token_estimate >= 0),
 status text not null check (status in ('processing','complete','failed')),
 created_at timestamptz not null default now(),
 primary key(owner_id, conversation_id, document_id),
 foreign key(owner_id, conversation_id) references public.chat_conversations(owner_id, conversation_id) on delete cascade
);
create table if not exists public.chat_document_pages (
 owner_id uuid not null,
 conversation_id text not null,
 document_id text not null,
 page_number integer not null check(page_number > 0),
 text text not null,
 primary key(owner_id, conversation_id, document_id, page_number),
 foreign key(owner_id, conversation_id, document_id) references public.chat_documents(owner_id, conversation_id, document_id) on delete cascade
);
alter table public.chat_documents enable row level security;
alter table public.chat_document_pages enable row level security;
-- Browser writes only objects authorized by a short-lived signed upload URL; metadata remains server-only.
