create table if not exists public.google_calendar_credentials (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  refresh_token_ciphertext text not null,
  refresh_token_nonce text not null,
  refresh_token_auth_tag text not null,
  scope text not null,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.google_calendar_credentials enable row level security;
-- Server-only table. The service-role client bypasses RLS; no public policies are intentional.
