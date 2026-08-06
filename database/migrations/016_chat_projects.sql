-- User-facing chat projects. Project membership is owner-scoped in every
-- repository query; existing document-project identifiers remain compatible.

create table if not exists public.chat_projects (
  owner_id uuid not null,
  project_id text not null,
  title text not null check (char_length(btrim(title)) between 1 and 160),
  instructions text not null default '' check (char_length(instructions) <= 12000),
  deleting_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, project_id),
  check (project_id ~ '^[A-Za-z0-9_-]{1,128}$')
);

alter table public.chat_conversations add column if not exists project_id text;
alter table public.chat_conversations add column if not exists is_project_library boolean not null default false;
alter table public.app_storage_objects add column if not exists chat_project_id text;
alter table public.chat_documents add column if not exists chat_project_id text;

create table if not exists public.chat_project_images (
  owner_id uuid not null,
  project_id text not null,
  image_id text not null,
  conversation_id text not null,
  user_message_id text not null,
  job_id text,
  storage_path text not null,
  storage_object_id uuid not null,
  name text,
  content_type text not null check (content_type in ('image/png','image/jpeg','image/webp','image/gif')),
  size bigint not null check (size >= 0),
  content_hash text,
  status text not null check (status in ('processing','complete','failed')),
  analysis jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, project_id, image_id),
  foreign key (owner_id, project_id)
    references public.chat_projects(owner_id, project_id) on delete cascade,
  foreign key (storage_object_id)
    references public.app_storage_objects(object_id) on delete cascade,
  unique (owner_id, project_id, storage_path)
);

update public.chat_documents documents
   set chat_project_id = conversations.project_id
  from public.chat_conversations conversations
 where documents.owner_id = conversations.owner_id
   and documents.conversation_id = conversations.conversation_id
   and documents.chat_project_id is null
   and conversations.project_id is not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'chat_conversations_chat_project_owner_fk'
  ) then
    alter table public.chat_conversations
      add constraint chat_conversations_chat_project_owner_fk
      foreign key (owner_id, project_id)
      references public.chat_projects(owner_id, project_id)
      on delete restrict;
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'app_storage_objects_chat_project_owner_fk'
  ) then
    alter table public.app_storage_objects
      add constraint app_storage_objects_chat_project_owner_fk
      foreign key (owner_id, chat_project_id)
      references public.chat_projects(owner_id, project_id)
      on delete restrict;
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'chat_documents_chat_project_owner_fk'
  ) then
    alter table public.chat_documents
      add constraint chat_documents_chat_project_owner_fk
      foreign key (owner_id, chat_project_id)
      references public.chat_projects(owner_id, project_id)
      on delete restrict;
  end if;
end;
$$;

create index if not exists chat_projects_owner_updated
  on public.chat_projects(owner_id, updated_at desc);
create index if not exists chat_projects_owner_active_updated
  on public.chat_projects(owner_id, updated_at desc)
  where deleting_at is null;
create index if not exists chat_conversations_owner_project_updated
  on public.chat_conversations(owner_id, project_id, updated_at desc)
  where project_id is not null;
create index if not exists app_storage_objects_owner_chat_project_created
  on public.app_storage_objects(owner_id, chat_project_id, created_at)
  where chat_project_id is not null;
create index if not exists chat_documents_owner_chat_project_created
  on public.chat_documents(owner_id, chat_project_id, created_at desc)
  where chat_project_id is not null;
create index if not exists chat_project_images_owner_project_updated
  on public.chat_project_images(owner_id, project_id, updated_at desc);

-- The original storage project_id column belongs to source-backed document
-- projects. Chat projects use their own column so the two namespaces never
-- overwrite each other's ownership metadata.
drop function if exists public.list_chat_conversations_fast(uuid);
create function public.list_chat_conversations_fast(p_owner_id uuid)
returns table(conversation_id text,title text,updated_at timestamptz,has_messages boolean,is_streaming boolean,project_id text)
language sql stable set search_path=public as $$
  select c.conversation_id,c.title,c.updated_at,
    exists(select 1 from public.chat_messages m where m.owner_id=c.owner_id and m.conversation_id=c.conversation_id),
    exists(select 1 from public.chat_messages m where m.owner_id=c.owner_id and m.conversation_id=c.conversation_id and m.role='assistant' and m.status='streaming'),
    c.project_id
  from public.chat_conversations c
  where c.owner_id=p_owner_id and not c.is_project_library
  order by c.updated_at desc;
$$;
