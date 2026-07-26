-- The image ID is the idempotency key. This migration owns the upload table
-- and its private storage bucket so it works on fresh databases as well as
-- installs that received the earlier attachment-only migration.
insert into storage.buckets (id, name, public)
values ('chat-images', 'chat-images', false)
on conflict (id) do update set public = false;

create table if not exists public.chat_image_uploads (
  owner_id uuid not null,
  conversation_id text not null,
  image_id text not null,
  user_message_id text not null,
  job_id text,
  storage_path text not null,
  name text,
  content_type text not null check (content_type in ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
  size bigint not null check (size >= 0),
  status text not null check (status in ('processing', 'complete', 'failed')),
  analysis jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, conversation_id, image_id),
  foreign key (owner_id, conversation_id) references public.chat_conversations(owner_id, conversation_id) on delete cascade
);

alter table public.chat_image_uploads enable row level security;

create index if not exists chat_image_uploads_owner_conversation
  on public.chat_image_uploads(owner_id, conversation_id, updated_at desc);

-- The image ID is the idempotency key. These fields let one server request
-- own processing and let a later request recover a worker that disappeared
-- without allowing an older worker to overwrite its result.
alter table public.chat_image_uploads
  add column if not exists content_hash text,
  add column if not exists claim_token uuid,
  add column if not exists claim_expires_at timestamptz;

create unique index if not exists chat_image_uploads_owner_storage_path
  on public.chat_image_uploads(owner_id, storage_path);

create index if not exists chat_image_uploads_processing_claim
  on public.chat_image_uploads(owner_id, conversation_id, claim_expires_at)
  where status = 'processing';
