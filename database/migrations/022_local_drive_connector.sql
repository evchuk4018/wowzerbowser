-- Local Drive is a deployment-authenticated MCP connector backed by the
-- private homelab service rather than a user OAuth account.
alter table public.connector_definitions drop constraint if exists connector_definitions_provider_check;
alter table public.connector_definitions add constraint connector_definitions_provider_check
  check (provider in ('managed','google_gmail','microsoft_outlook','remote_mcp','local_drive'));
