create table if not exists public.user_skills (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  builtin_key text,
  builtin_version integer check (builtin_version is null or builtin_version > 0),
  customized boolean not null default false,
  name text not null check (char_length(name) between 1 and 80),
  normalized_name text not null check (char_length(normalized_name) between 1 and 80),
  summary text not null check (char_length(summary) between 1 and 200),
  instructions text not null check (char_length(instructions) between 1 and 12000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (owner_id, builtin_key),
  unique (id, owner_id),
  check (
    (builtin_key is null and builtin_version is null and customized)
    or
    (builtin_key is not null and builtin_version is not null)
  )
);

create unique index if not exists user_skills_owner_active_name
  on public.user_skills(owner_id, normalized_name)
  where deleted_at is null;

create index if not exists user_skills_owner_updated
  on public.user_skills(owner_id, updated_at desc)
  where deleted_at is null;

alter table public.user_skills enable row level security;
-- Server-only table. The service-role client bypasses RLS; no public policies are intentional.
