-- One local owner credential record for Auth.js Credentials authentication.
-- The singleton key prevents a second owner from being created. owner_id is
-- the stable APP_OWNER_ID used by the local PostgreSQL repositories.

create table if not exists public.app_owner_credentials (
  singleton boolean primary key default true check (singleton),
  owner_id uuid not null unique,
  email text not null unique check (email = lower(email)),
  password_hash text not null,
  session_version bigint not null default 0 check (session_version >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists app_owner_credentials_email on public.app_owner_credentials(email);
