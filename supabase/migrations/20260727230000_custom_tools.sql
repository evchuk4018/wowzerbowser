create table if not exists public.custom_tools (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  name text not null,
  description text not null,
  instructions text not null default '',
  input_schema jsonb not null,
  python_source text not null,
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, name),
  unique (id, owner_id)
);

create table if not exists public.custom_tool_secrets (
  tool_id uuid not null,
  owner_id uuid not null,
  name text not null,
  ciphertext text not null,
  nonce text not null,
  auth_tag text not null,
  fingerprint text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tool_id, name),
  foreign key (tool_id, owner_id) references public.custom_tools(id, owner_id) on delete cascade
);

create index if not exists custom_tools_owner_enabled on public.custom_tools(owner_id, enabled);
create index if not exists custom_tool_secrets_owner on public.custom_tool_secrets(owner_id, tool_id);
alter table public.custom_tools enable row level security;
alter table public.custom_tool_secrets enable row level security;
-- Server-only tables. The service-role client bypasses RLS; no public policies are intentional.
