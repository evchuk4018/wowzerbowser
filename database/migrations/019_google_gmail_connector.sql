-- Gmail is a direct Google OAuth connector rather than a Pipedream-managed one.
alter table public.connector_definitions drop constraint if exists connector_definitions_provider_check;
alter table public.connector_definitions add constraint connector_definitions_provider_check
  check (provider in ('managed','google_gmail','remote_mcp'));

-- Existing Pipedream Gmail credentials are not compatible with the direct adapter.
update public.connector_definitions set provider='google_gmail' where id='gmail';
update public.connector_connections set status='reconnect_required', updated_at=now() where connector_id='gmail' and status='connected';
delete from public.connector_tools where connector_id='gmail';
