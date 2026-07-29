-- `user_memories` may already exist from Supabase's legacy memory worker.
-- The durable profile migration adds its own columns to that relation, but
-- `create table if not exists` cannot remove the legacy required columns.
-- Current profile writes intentionally use owner_id/content provenance and do
-- not populate these legacy fields, so they must remain optional.

alter table public.user_memories
  alter column user_id drop not null,
  alter column memory_type drop not null,
  alter column dedup_key_hash drop not null,
  alter column origin drop not null;
