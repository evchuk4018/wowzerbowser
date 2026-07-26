-- Image descriptors are kept on the message version that owns them. The
-- service-role chat history store is the only writer, so storage paths and
-- analysis metadata never become browser-facing public storage records.
alter table public.chat_messages
  add column if not exists attachments jsonb not null default '[]'::jsonb;

alter table public.chat_messages
  drop constraint if exists chat_messages_attachments_array;

alter table public.chat_messages
  add constraint chat_messages_attachments_array
  check (jsonb_typeof(attachments) = 'array');

create index if not exists chat_messages_image_attachments
  on public.chat_messages using gin (attachments);
