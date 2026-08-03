-- Application binaries live below the bind-mounted application directory.
-- The object key is opaque metadata; callers never turn user input into a
-- filesystem path. The filesystem adapter validates the same shape before any
-- open, rename, read, or delete operation.

create table if not exists public.app_storage_objects (
  object_id uuid primary key,
  owner_id uuid not null,
  conversation_id text,
  document_id text,
  message_id text,
  project_id text,
  revision_id text,
  kind text not null check (kind in ('document','image','artifact','revision-source','other')),
  object_key text not null unique check (object_key ~ '^objects/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  original_filename text,
  content_type text not null check (char_length(content_type) between 1 and 255),
  size bigint not null default 0 check (size >= 0 and size <= 104857600),
  sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  state text not null check (state in ('uploading','complete','failed')),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

alter table public.chat_documents add column if not exists storage_object_id uuid;
alter table public.chat_image_uploads add column if not exists storage_object_id uuid;
alter table public.chat_document_revision_files add column if not exists storage_object_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'chat_documents_storage_object_fk') then
    alter table public.chat_documents add constraint chat_documents_storage_object_fk
      foreign key (storage_object_id) references public.app_storage_objects(object_id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chat_image_uploads_storage_object_fk') then
    alter table public.chat_image_uploads add constraint chat_image_uploads_storage_object_fk
      foreign key (storage_object_id) references public.app_storage_objects(object_id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chat_revision_files_storage_object_fk') then
    alter table public.chat_document_revision_files add constraint chat_revision_files_storage_object_fk
      foreign key (storage_object_id) references public.app_storage_objects(object_id) on delete set null;
  end if;
end $$;

create index if not exists app_storage_objects_owner_conversation on public.app_storage_objects(owner_id, conversation_id, created_at);
create index if not exists app_storage_objects_uploading on public.app_storage_objects(owner_id, state, created_at);
drop index if exists public.app_storage_objects_document_link;
create index if not exists app_storage_objects_document_link on public.app_storage_objects(owner_id, conversation_id, document_id)
  where kind = 'document' and document_id is not null;
create index if not exists app_storage_objects_revision_link on public.app_storage_objects(owner_id, conversation_id, project_id, revision_id);
