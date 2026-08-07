create table if not exists public.runtime_configurations (
  owner_id uuid primary key,
  values jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
