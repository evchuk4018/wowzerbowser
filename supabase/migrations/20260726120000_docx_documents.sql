update storage.buckets
set allowed_mime_types = array['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']
where id = 'chat-documents';

alter table public.chat_documents drop constraint if exists chat_documents_content_type_check;
alter table public.chat_documents add constraint chat_documents_content_type_check
  check (content_type in ('application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'));
alter table public.chat_documents add column if not exists has_images boolean not null default false;
alter table public.chat_documents add column if not exists image_count integer not null default 0 check (image_count >= 0);
alter table public.chat_documents add column if not exists analyzed_image_count integer not null default 0 check (analyzed_image_count between 0 and 4);
alter table public.chat_documents add column if not exists image_analyses jsonb not null default '[]'::jsonb;
