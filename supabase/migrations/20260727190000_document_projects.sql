insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
values ('chat-document-sources','chat-document-sources',false,26214400,null)
on conflict(id) do update set public=false,file_size_limit=26214400,allowed_mime_types=null;

create table if not exists public.chat_document_projects (
 owner_id uuid not null, conversation_id text not null, project_id text not null,
 origin text not null check(origin in ('generated','uploaded')), title text not null,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 primary key(owner_id,conversation_id,project_id),
 foreign key(owner_id,conversation_id) references public.chat_conversations(owner_id,conversation_id) on delete cascade
);
create table if not exists public.chat_document_revisions (
 owner_id uuid not null, conversation_id text not null, project_id text not null, revision_id text not null,
 parent_revision_id text, rendered_document_id text not null, entrypoint text not null, output_path text not null,
 output_filename text not null, output_content_type text not null check(output_content_type in ('application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document')),
 output_sha256 text not null check(output_sha256 ~ '^[0-9a-f]{64}$'), source_completeness text not null check(source_completeness in ('complete','entrypoint-only')),
 manifest jsonb not null, status text not null check(status in ('creating','complete','failed')), created_by_job_id text,
 created_at timestamptz not null default now(), primary key(owner_id,conversation_id,project_id,revision_id),
 foreign key(owner_id,conversation_id,project_id) references public.chat_document_projects(owner_id,conversation_id,project_id) on delete cascade,
 unique(owner_id,conversation_id,rendered_document_id)
);
create table if not exists public.chat_document_revision_files (
 owner_id uuid not null, conversation_id text not null, project_id text not null, revision_id text not null,
 relative_path text not null, storage_path text not null unique, content_type text not null,
 size bigint not null check(size between 1 and 26214400), sha256 text not null check(sha256 ~ '^[0-9a-f]{64}$'), created_at timestamptz not null default now(),
 primary key(owner_id,conversation_id,project_id,revision_id,relative_path),
 foreign key(owner_id,conversation_id,project_id,revision_id) references public.chat_document_revisions(owner_id,conversation_id,project_id,revision_id) on delete cascade
);
alter table public.chat_documents add column if not exists project_id text;
alter table public.chat_documents add column if not exists revision_id text;
alter table public.chat_documents add column if not exists origin text check(origin in ('generated','uploaded'));
alter table public.chat_document_projects enable row level security;
alter table public.chat_document_revisions enable row level security;
alter table public.chat_document_revision_files enable row level security;
-- No browser write policies: service-role operations own all project metadata and source objects.
