-- Issue #68 keeps integration state on the local PostgreSQL service. Connector
-- metadata is encrypted alongside credentials, and Discord message preparation
-- has a lease so a worker restart can safely recover an interrupted ingest.

alter table public.connector_connections
  add column if not exists metadata_ciphertext text,
  add column if not exists metadata_nonce text,
  add column if not exists metadata_auth_tag text;

alter table public.discord_dm_messages
  add column if not exists processing_lease_token uuid,
  add column if not exists processing_lease_expires_at timestamptz;

create index if not exists discord_dm_messages_processing
  on public.discord_dm_messages(owner_id, status, processing_lease_expires_at, created_at)
  where status = 'processing';

create or replace function public.claim_pending_discord_messages(
  p_owner_id uuid,
  p_limit integer default 1,
  p_lease_ms integer default 300000
)
returns setof public.discord_dm_messages
language sql
set search_path = public
as $$
  with candidates as (
    select owner_id, discord_message_id
      from public.discord_dm_messages
     where owner_id = p_owner_id
       and status = 'processing'
       and (processing_lease_expires_at is null or processing_lease_expires_at <= clock_timestamp())
     order by created_at, discord_message_id
     for update skip locked
     limit greatest(0, least(coalesce(p_limit, 1), 4))
  )
  update public.discord_dm_messages messages
     set processing_lease_token = gen_random_uuid(),
         processing_lease_expires_at = clock_timestamp() + make_interval(secs => greatest(60, least(coalesce(p_lease_ms, 300000), 1800000)) / 1000.0),
         updated_at = clock_timestamp()
    from candidates
   where messages.owner_id = candidates.owner_id
     and messages.discord_message_id = candidates.discord_message_id
  returning messages.*;
$$;
