-- Preserve the plain-text extraction used for search while storing the richer
-- Markdown and structured metadata produced by OpenDataLoader.
alter table public.chat_documents
  add column if not exists provider_metadata jsonb;

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'chat_documents_analyzed_image_count_check') then
    alter table public.chat_documents drop constraint chat_documents_analyzed_image_count_check;
  end if;
  alter table public.chat_documents add constraint chat_documents_analyzed_image_count_check check (analyzed_image_count >= 0);
exception when duplicate_object then
  null;
end $$;

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'app_storage_objects_kind_check') then
    alter table public.app_storage_objects drop constraint app_storage_objects_kind_check;
  end if;
  alter table public.app_storage_objects add constraint app_storage_objects_kind_check
    check (kind in ('document','image','document-image','artifact','revision-source','other'));
exception when duplicate_object then
  null;
end $$;

alter table public.chat_document_pages
  drop constraint if exists chat_document_pages_extraction_method_check;
alter table public.chat_document_pages
  add constraint chat_document_pages_extraction_method_check
  check (extraction_method in ('native','ocr','opendataloader','blank'));

alter table public.chat_document_pages
  add column if not exists markdown text,
  add column if not exists provider_metadata jsonb;

-- Document-derived images are not chat uploads: they have no user message and
-- are not subject to the per-turn chat_image_uploads limit.
create table if not exists public.chat_document_images (
  owner_id uuid not null,
  conversation_id text not null,
  document_id text not null,
  image_id text not null,
  page_number integer not null check (page_number > 0),
  storage_object_id uuid,
  storage_path text,
  content_type text,
  provider_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (owner_id, conversation_id, document_id, image_id),
  foreign key (owner_id, conversation_id, document_id)
    references public.chat_documents(owner_id, conversation_id, document_id) on delete cascade,
  foreign key (storage_object_id)
    references public.app_storage_objects(object_id) on delete set null
);

alter table public.chat_document_images enable row level security;

create index if not exists chat_document_images_page
  on public.chat_document_images(owner_id, conversation_id, document_id, page_number);
create index if not exists chat_document_images_storage
  on public.chat_document_images(owner_id, storage_object_id)
  where storage_object_id is not null;

create or replace function public.register_chat_document(
  p_owner_id uuid,
  p_conversation_id text,
  p_document jsonb,
  p_user_message_id text,
  p_job_id text,
  p_pages jsonb,
  p_storage_path text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  page_total integer;
  distinct_pages integer;
  min_page integer;
  max_page integer;
  expected_pages integer := (p_document->>'pageCount')::integer;
  now_at timestamptz := clock_timestamp();
  v_document_id text := p_document->>'id';
begin
  if v_document_id is null or expected_pages is null or expected_pages < 1
    or jsonb_typeof(p_pages) <> 'array' then
    raise exception 'Document registration metadata is incomplete.' using errcode = '22023';
  end if;

  insert into public.chat_conversations(owner_id, conversation_id, title, updated_at)
    values (p_owner_id, p_conversation_id, 'New conversation', now_at)
    on conflict (owner_id, conversation_id) do update set updated_at = excluded.updated_at;

  insert into public.chat_documents(
    owner_id, conversation_id, document_id, user_message_id, job_id, storage_path,
    filename, content_type, size, page_count, token_estimate, has_images, image_count,
    analyzed_image_count, image_analyses, provider_metadata, project_id, revision_id,
    parent_revision_id, origin, editable, source_completeness, status
  ) values (
    p_owner_id, p_conversation_id, v_document_id, p_user_message_id, p_job_id, p_storage_path,
    p_document->>'name', p_document->>'contentType', (p_document->>'size')::bigint,
    expected_pages, (p_document->>'tokenEstimate')::integer,
    coalesce((p_document->>'hasImages')::boolean, false), coalesce((p_document->>'imageCount')::integer, 0),
    coalesce((p_document->>'analyzedImageCount')::integer, 0), coalesce(p_document->'imageAnalyses', '[]'::jsonb),
    case when jsonb_typeof(p_document->'providerMetadata') = 'object' then p_document->'providerMetadata' end,
    p_document->>'projectId', p_document->>'revisionId', p_document->>'parentRevisionId',
    p_document->>'origin', coalesce((p_document->>'editable')::boolean, false),
    p_document->>'sourceCompleteness', 'processing'
  ) on conflict (owner_id, conversation_id, document_id) do update set
    user_message_id = excluded.user_message_id, job_id = excluded.job_id,
    storage_path = excluded.storage_path, filename = excluded.filename,
    content_type = excluded.content_type, size = excluded.size,
    page_count = excluded.page_count, token_estimate = excluded.token_estimate,
    has_images = excluded.has_images, image_count = excluded.image_count,
    analyzed_image_count = excluded.analyzed_image_count, image_analyses = excluded.image_analyses,
    provider_metadata = excluded.provider_metadata, project_id = excluded.project_id,
    revision_id = excluded.revision_id, parent_revision_id = excluded.parent_revision_id,
    origin = excluded.origin, editable = excluded.editable,
    source_completeness = excluded.source_completeness, status = 'processing';

  delete from public.chat_document_pages
    where owner_id = p_owner_id and conversation_id = p_conversation_id and document_id = v_document_id;
  insert into public.chat_document_pages(
    owner_id, conversation_id, document_id, page_number, text, markdown,
    extraction_method, failure, provider_metadata
  )
    select p_owner_id, p_conversation_id, v_document_id,
      (page->>'pageNumber')::integer, coalesce(page->>'text', ''), page->>'markdown',
      coalesce(page->>'extractionMethod', 'native'), page->'failure',
      case when jsonb_typeof(page->'providerMetadata') = 'object' then page->'providerMetadata' end
    from jsonb_array_elements(p_pages) as pages(page);

  delete from public.chat_document_images
    where owner_id = p_owner_id and conversation_id = p_conversation_id and document_id = v_document_id;
  insert into public.chat_document_images(
    owner_id, conversation_id, document_id, image_id, page_number,
    storage_object_id, storage_path, content_type, provider_metadata
  )
    select p_owner_id, p_conversation_id, v_document_id,
      coalesce(nullif(image->>'imageId', ''), nullif(image->>'id', ''), nullif(image->>'source', '')),
      (image->>'pageNumber')::integer,
      nullif(image->>'storageObjectId', '')::uuid,
      nullif(image->>'storagePath', ''),
      nullif(image->>'contentType', ''),
      case when jsonb_typeof(image->'providerMetadata') = 'object' then image->'providerMetadata' else '{}'::jsonb end
    from jsonb_array_elements(
      case when jsonb_typeof(p_document->'images') = 'array' then p_document->'images' else '[]'::jsonb end
    ) as image_rows(image)
    where coalesce(nullif(image->>'imageId', ''), nullif(image->>'id', ''), nullif(image->>'source', '')) is not null;

  select count(*), count(distinct page_number), min(page_number), max(page_number)
    into page_total, distinct_pages, min_page, max_page
    from public.chat_document_pages
    where owner_id = p_owner_id and conversation_id = p_conversation_id and document_id = v_document_id;
  if page_total <> expected_pages or distinct_pages <> expected_pages or min_page <> 1 or max_page <> expected_pages then
    raise exception 'Document page registration is incomplete.' using errcode = '22023';
  end if;

  update public.chat_documents set status = 'complete'
    where owner_id = p_owner_id and conversation_id = p_conversation_id and document_id = v_document_id;
  return jsonb_build_object('documentId', v_document_id, 'status', 'complete');
end;
$$;

-- The application database role owns and invokes this function. Keep the
-- security-definer entrypoint private without assuming Supabase roles exist.
revoke all on function public.register_chat_document(uuid, text, jsonb, text, text, jsonb, text) from public;
