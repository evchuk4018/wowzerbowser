create table if not exists public.connector_definitions (
  id text primary key,
  owner_id uuid,
  name text not null,
  description text not null,
  icon_url text,
  version text not null,
  provider text not null check (provider in ('managed','remote_mcp')),
  auth_type text not null check (auth_type in ('oauth2','api_key','none')),
  capabilities jsonb not null default '[]'::jsonb,
  default_approval jsonb not null,
  endpoint_url text,
  health_status text not null default 'unknown' check (health_status in ('unknown','healthy','unavailable')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.connector_installations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  connector_id text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, connector_id),
  foreign key (connector_id) references public.connector_definitions(id) on delete cascade
);

create table if not exists public.connector_connections (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  connector_id text not null,
  account_label text,
  account_email text,
  status text not null default 'connected' check (status in ('connected','reconnect_required','unavailable','disconnected')),
  is_default boolean not null default false,
  credentials_ciphertext text,
  credentials_nonce text,
  credentials_auth_tag text,
  credentials_fingerprint text,
  metadata jsonb not null default '{}'::jsonb,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_id),
  foreign key (connector_id) references public.connector_definitions(id) on delete cascade
);

create table if not exists public.connector_tools (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  connector_id text not null,
  connection_id uuid,
  name text not null,
  description text not null,
  input_schema jsonb not null,
  access text not null check (access in ('read','write','destructive')),
  enabled boolean not null default true,
  connector_version text not null,
  discovered_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, connector_id, connection_id, name),
  foreign key (connector_id) references public.connector_definitions(id) on delete cascade,
  foreign key (connection_id) references public.connector_connections(id) on delete cascade
);

create table if not exists public.connector_permissions (
  owner_id uuid not null,
  connector_id text not null,
  tool_name text not null,
  enabled boolean not null default true,
  approval_mode text not null check (approval_mode in ('never','always')),
  updated_at timestamptz not null default now(),
  primary key (owner_id, connector_id, tool_name)
);

create table if not exists public.connector_call_logs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  connector_id text not null,
  connection_id uuid,
  tool_name text not null,
  access text not null,
  arguments jsonb not null default '{}'::jsonb,
  ok boolean,
  error_code text,
  duration_ms integer,
  created_at timestamptz not null default now()
);

create table if not exists public.connector_approval_requests (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  job_id text,
  conversation_id text,
  connector_id text not null,
  connection_id uuid not null,
  tool_name text not null,
  description text not null,
  access text not null,
  important_arguments jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending','allow_once','always_allow','deny','expired')),
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists connector_connections_owner on public.connector_connections(owner_id, connector_id, status);
create index if not exists connector_tools_owner on public.connector_tools(owner_id, connector_id, enabled);
create index if not exists connector_approval_owner on public.connector_approval_requests(owner_id, status);
create index if not exists connector_call_logs_owner on public.connector_call_logs(owner_id, created_at desc);

alter table public.connector_definitions enable row level security;
alter table public.connector_installations enable row level security;
alter table public.connector_connections enable row level security;
alter table public.connector_tools enable row level security;
alter table public.connector_permissions enable row level security;
alter table public.connector_call_logs enable row level security;
alter table public.connector_approval_requests enable row level security;
-- Server-only tables. The service-role client bypasses RLS; no public policies are intentional.
