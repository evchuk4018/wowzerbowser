-- Local Drive is private and owner-controlled. Connector actions run without
-- approval except when their arguments explicitly replace an existing file.
-- Argument-sensitive overwrite approval is enforced by connector policy.
update public.connector_definitions
set version = '1.2.0',
    default_approval = '{"read":"never","write":"never","destructive":"never"}'::jsonb,
    updated_at = now()
where id = 'local_drive';

update public.connector_tools
set access = 'read',
    connector_version = '1.2.0',
    updated_at = now()
where connector_id = 'local_drive'
  and name = 'drive_download_to_workspace';

update public.connector_tools
set connector_version = '1.2.0',
    updated_at = now()
where connector_id = 'local_drive'
  and connector_version <> '1.2.0';

update public.connector_tools
set description = 'Permanently delete a Local Drive file or folder.',
    updated_at = now()
where connector_id = 'local_drive'
  and name = 'drive_delete_permanently';

update public.connector_permissions
set approval_mode = 'never',
    updated_at = now()
where connector_id = 'local_drive';
