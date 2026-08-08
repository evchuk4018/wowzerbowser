-- Allow the direct Microsoft OAuth Outlook connector without changing existing data.
alter table public.connector_definitions drop constraint if exists connector_definitions_provider_check;
alter table public.connector_definitions add constraint connector_definitions_provider_check
  check (provider in ('managed','google_gmail','microsoft_outlook','remote_mcp'));
