alter table public.user_memories
  add column if not exists is_sensitive boolean not null default false;
