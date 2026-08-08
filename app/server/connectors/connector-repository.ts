import "server-only";

import type { ConnectorManifest, ConnectorProviderKind } from "../../../lib/connector-protocol";
import { databaseOwnerId, isoTimestamp, jsonb, query, withTransaction } from "../database/database";

export type ConnectorDefinitionRow = {
  id: string; owner_id: string | null; name: string; description: string; icon_url: string | null;
  version: string; provider: ConnectorProviderKind; auth_type: "oauth2" | "api_key" | "none";
  capabilities: unknown; default_approval: unknown; endpoint_url: string | null; health_status: string;
};
export type ConnectorConnectionRow = {
  id: string; owner_id: string; connector_id: string; account_label: string | null; account_email: string | null;
  status: string; is_default: boolean; credentials_ciphertext: string | null; credentials_nonce: string | null;
  credentials_auth_tag: string | null; credentials_fingerprint: string | null;
  metadata: Record<string, unknown>; metadata_ciphertext: string | null; metadata_nonce: string | null; metadata_auth_tag: string | null;
  connected_at: string; updated_at: string;
};
export type ConnectorToolRow = {
  id: string; owner_id: string | null; connector_id: string; connection_id: string | null; name: string;
  description: string; input_schema: Record<string, unknown>; access: "read" | "write" | "destructive";
  enabled: boolean; connector_version: string; discovered_at: string; updated_at: string;
};

const definitionColumns = "id,owner_id,name,description,icon_url,version,provider,auth_type,capabilities,default_approval,endpoint_url,health_status";
const connectionColumns = "id,owner_id,connector_id,account_label,account_email,status,is_default,credentials_ciphertext,credentials_nonce,credentials_auth_tag,credentials_fingerprint,metadata,metadata_ciphertext,metadata_nonce,metadata_auth_tag,connected_at,updated_at";
const toolColumns = "id,owner_id,connector_id,connection_id,name,description,input_schema,access,enabled,connector_version,discovered_at,updated_at";

function connectionValue(row: ConnectorConnectionRow): ConnectorConnectionRow {
  return { ...row, connected_at: isoTimestamp(row.connected_at), updated_at: isoTimestamp(row.updated_at) };
}

function toolValue(row: ConnectorToolRow): ConnectorToolRow {
  return { ...row, discovered_at: isoTimestamp(row.discovered_at), updated_at: isoTimestamp(row.updated_at) };
}

export async function listCustomDefinitions(ownerId: string): Promise<ConnectorDefinitionRow[]> {
  return query<ConnectorDefinitionRow>(`select ${definitionColumns} from connector_definitions where owner_id=$1 order by name`, [databaseOwnerId(ownerId)]);
}

export async function upsertDefinition(ownerId: string, values: Omit<ConnectorDefinitionRow, "owner_id" | "health_status"> & { endpoint_url?: string | null }): Promise<void> {
  await query(`insert into connector_definitions(id,owner_id,name,description,icon_url,version,provider,auth_type,capabilities,default_approval,endpoint_url,health_status,updated_at)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,'unknown',$12)
    on conflict(id) do update set owner_id=excluded.owner_id,name=excluded.name,description=excluded.description,icon_url=excluded.icon_url,version=excluded.version,provider=excluded.provider,auth_type=excluded.auth_type,capabilities=excluded.capabilities,default_approval=excluded.default_approval,endpoint_url=excluded.endpoint_url,updated_at=excluded.updated_at`,
    [values.id, databaseOwnerId(ownerId), values.name, values.description, values.icon_url, values.version, values.provider, values.auth_type, jsonb(values.capabilities), jsonb(values.default_approval), values.endpoint_url ?? null, new Date().toISOString()]);
}

export async function ensureManagedDefinition(manifest: ConnectorManifest): Promise<void> {
  await query(`insert into connector_definitions(id,owner_id,name,description,icon_url,version,provider,auth_type,capabilities,default_approval,health_status,updated_at)
    values($1,null,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,'unknown',$10)
    on conflict(id) do update set owner_id=null,name=excluded.name,description=excluded.description,icon_url=excluded.icon_url,version=excluded.version,provider=excluded.provider,auth_type=excluded.auth_type,capabilities=excluded.capabilities,default_approval=excluded.default_approval,updated_at=excluded.updated_at`,
    [manifest.id, manifest.name, manifest.description, manifest.iconUrl ?? null, manifest.version, manifest.provider, manifest.auth.type, jsonb(manifest.capabilities), jsonb(manifest.defaultApproval), new Date().toISOString()]);
}

export async function deleteDefinition(ownerId: string, connectorId: string): Promise<boolean> {
  return (await query<{ id: string }>("delete from connector_definitions where owner_id=$1 and id=$2 returning id", [databaseOwnerId(ownerId), connectorId])).length > 0;
}

export async function ensureInstallation(ownerId: string, connectorId: string): Promise<void> {
  await query(`insert into connector_installations(owner_id,connector_id,enabled,updated_at) values($1,$2,true,$3)
    on conflict(owner_id,connector_id) do update set enabled=true,updated_at=excluded.updated_at`, [databaseOwnerId(ownerId), connectorId, new Date().toISOString()]);
}

export async function getInstallation(ownerId: string, connectorId: string): Promise<{ enabled: boolean } | null> {
  const [row] = await query<{ enabled: boolean }>("select enabled from connector_installations where owner_id=$1 and connector_id=$2", [databaseOwnerId(ownerId), connectorId]);
  return row ?? null;
}

export async function listConnections(ownerId: string, connectorId: string): Promise<ConnectorConnectionRow[]> {
  return (await query<ConnectorConnectionRow>(`select ${connectionColumns} from connector_connections where owner_id=$1 and connector_id=$2 and status<>'disconnected' order by connected_at`, [databaseOwnerId(ownerId), connectorId])).map(connectionValue);
}

export async function getConnection(ownerId: string, connectionId: string): Promise<ConnectorConnectionRow | null> {
  const [row] = await query<ConnectorConnectionRow>(`select ${connectionColumns} from connector_connections where owner_id=$1 and id=$2`, [databaseOwnerId(ownerId), connectionId]);
  return row ? connectionValue(row) : null;
}

export async function getDefaultConnection(ownerId: string, connectorId: string): Promise<ConnectorConnectionRow | null> {
  const owner = databaseOwnerId(ownerId);
  const [preferred] = await query<ConnectorConnectionRow>(`select ${connectionColumns} from connector_connections where owner_id=$1 and connector_id=$2 and status='connected' and is_default=true limit 1`, [owner, connectorId]);
  if (preferred) return connectionValue(preferred);
  const [fallback] = await query<ConnectorConnectionRow>(`select ${connectionColumns} from connector_connections where owner_id=$1 and connector_id=$2 and status='connected' order by connected_at limit 1`, [owner, connectorId]);
  return fallback ? connectionValue(fallback) : null;
}

export async function insertConnection(ownerId: string, values: {
  connectorId: string; accountLabel?: string; accountEmail?: string;
  credentials: { ciphertext: string; nonce: string; authTag: string; fingerprint: string };
  metadata?: Record<string, unknown>;
  encryptedMetadata?: { ciphertext: string; nonce: string; authTag: string; fingerprint: string };
}): Promise<string> {
  const owner = databaseOwnerId(ownerId);
  const existing = await listConnections(ownerId, values.connectorId);
  const [row] = await query<{ id: string }>(`insert into connector_connections(owner_id,connector_id,account_label,account_email,status,is_default,credentials_ciphertext,credentials_nonce,credentials_auth_tag,credentials_fingerprint,metadata,metadata_ciphertext,metadata_nonce,metadata_auth_tag)
    values($1,$2,$3,$4,'connected',$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13) returning id`, [
    owner,
    values.connectorId,
    values.accountLabel ?? null,
    values.accountEmail ?? null,
    existing.length === 0,
    values.credentials.ciphertext,
    values.credentials.nonce,
    values.credentials.authTag,
    values.credentials.fingerprint,
    jsonb(values.encryptedMetadata ? {} : values.metadata ?? {}),
    values.encryptedMetadata?.ciphertext ?? null,
    values.encryptedMetadata?.nonce ?? null,
    values.encryptedMetadata?.authTag ?? null,
  ]);
  return row.id;
}

export async function setDefaultConnection(ownerId: string, connectorId: string, connectionId: string): Promise<void> {
  const owner = databaseOwnerId(ownerId);
  const now = new Date().toISOString();
  await withTransaction(async (tx) => {
    await tx.unsafe("update connector_connections set is_default=false,updated_at=$1 where owner_id=$2 and connector_id=$3", [now, owner, connectorId]);
    await tx.unsafe("update connector_connections set is_default=true,updated_at=$1 where owner_id=$2 and connector_id=$3 and id=$4 and status='connected'", [now, owner, connectorId, connectionId]);
  });
}

export async function markConnection(ownerId: string, connectionId: string, status: "connected" | "reconnect_required" | "unavailable" | "disconnected"): Promise<void> {
  await query("update connector_connections set status=$1,updated_at=$2 where owner_id=$3 and id=$4", [status, new Date().toISOString(), databaseOwnerId(ownerId), connectionId]);
}

export async function deleteConnection(ownerId: string, connectionId: string): Promise<void> {
  await query("delete from connector_connections where owner_id=$1 and id=$2", [databaseOwnerId(ownerId), connectionId]);
}

export async function listTools(ownerId: string, connectorId: string): Promise<ConnectorToolRow[]> {
  return (await query<ConnectorToolRow>(`select ${toolColumns} from connector_tools where connector_id=$1 and (owner_id=$2 or owner_id is null) order by name`, [connectorId, databaseOwnerId(ownerId)])).map(toolValue);
}

export async function upsertTools(ownerId: string, connectorId: string, connectionId: string | null, tools: Array<Omit<ConnectorToolRow, "id" | "owner_id" | "connector_id" | "connection_id" | "updated_at"> & { name: string }>): Promise<void> {
  if (!tools.length) return;
  const owner = databaseOwnerId(ownerId);
  const now = new Date().toISOString();
  for (const tool of tools) await query(`insert into connector_tools(owner_id,connector_id,connection_id,name,description,input_schema,access,enabled,connector_version,discovered_at,updated_at)
    values($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11)
    on conflict(owner_id,connector_id,connection_id,name) do update set description=excluded.description,input_schema=excluded.input_schema,access=excluded.access,enabled=excluded.enabled,connector_version=excluded.connector_version,discovered_at=excluded.discovered_at,updated_at=excluded.updated_at`, [owner, connectorId, connectionId, tool.name, tool.description, jsonb(tool.input_schema), tool.access, tool.enabled, tool.connector_version, tool.discovered_at, now]);
}

export async function updateTool(ownerId: string, connectorId: string, toolName: string, enabled: boolean): Promise<boolean> {
  return (await query<{ id: string }>("update connector_tools set enabled=$1,updated_at=$2 where owner_id=$3 and connector_id=$4 and name=$5 returning id", [enabled, new Date().toISOString(), databaseOwnerId(ownerId), connectorId, toolName])).length > 0;
}

export async function getPermission(ownerId: string, connectorId: string, toolName: string): Promise<{ enabled: boolean; approval_mode: "never" | "always" } | null> {
  const [row] = await query<{ enabled: boolean; approval_mode: "never" | "always" }>("select enabled,approval_mode from connector_permissions where owner_id=$1 and connector_id=$2 and tool_name=$3", [databaseOwnerId(ownerId), connectorId, toolName]);
  return row ?? null;
}

export async function setPermission(ownerId: string, connectorId: string, toolName: string, values: { enabled?: boolean; approvalMode?: "never" | "always" }): Promise<void> {
  const current = await getPermission(ownerId, connectorId, toolName);
  await query(`insert into connector_permissions(owner_id,connector_id,tool_name,enabled,approval_mode,updated_at) values($1,$2,$3,$4,$5,$6)
    on conflict(owner_id,connector_id,tool_name) do update set enabled=excluded.enabled,approval_mode=excluded.approval_mode,updated_at=excluded.updated_at`, [databaseOwnerId(ownerId), connectorId, toolName, values.enabled ?? current?.enabled ?? true, values.approvalMode ?? current?.approval_mode ?? "always", new Date().toISOString()]);
}

export async function logCall(values: { ownerId: string; connectorId: string; connectionId: string; toolName: string; access: string; arguments: Record<string, unknown>; ok: boolean; errorCode?: string; durationMs: number }): Promise<void> {
  await query("insert into connector_call_logs(owner_id,connector_id,connection_id,tool_name,access,arguments,ok,error_code,duration_ms) values($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)", [databaseOwnerId(values.ownerId), values.connectorId, values.connectionId, values.toolName, values.access, jsonb(values.arguments), values.ok, values.errorCode ?? null, values.durationMs]);
}

export async function createApproval(values: { ownerId: string; jobId?: string; conversationId?: string; connectorId: string; connectionId: string; toolName: string; description: string; access: string; importantArguments: Record<string, unknown> }): Promise<string> {
  const [row] = await query<{ id: string }>("insert into connector_approval_requests(owner_id,job_id,conversation_id,connector_id,connection_id,tool_name,description,access,important_arguments) values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) returning id", [databaseOwnerId(values.ownerId), values.jobId ?? null, values.conversationId ?? null, values.connectorId, values.connectionId, values.toolName, values.description, values.access, jsonb(values.importantArguments)]);
  return row.id;
}

export async function getApproval(ownerId: string, approvalId: string) {
  const [row] = await query<Record<string, unknown>>("select id,owner_id,job_id,conversation_id,connector_id,connection_id,tool_name,description,access,important_arguments,status,created_at from connector_approval_requests where owner_id=$1 and id=$2", [databaseOwnerId(ownerId), approvalId]);
  return row ? { ...row, created_at: isoTimestamp(row.created_at) } as { id: string; owner_id: string; job_id: string | null; conversation_id: string | null; connector_id: string; connection_id: string; tool_name: string; description: string; access: "read" | "write" | "destructive"; important_arguments: Record<string, unknown>; status: string; created_at: string } : undefined;
}

export async function resolveApproval(ownerId: string, approvalId: string, status: "allow_once" | "always_allow" | "deny"): Promise<boolean> {
  return (await query<{ id: string }>("update connector_approval_requests set status=$1,resolved_at=$2 where owner_id=$3 and id=$4 and status='pending' returning id", [status, new Date().toISOString(), databaseOwnerId(ownerId), approvalId])).length > 0;
}

export async function readApprovalStatus(ownerId: string, approvalId: string): Promise<string | null> {
  const [row] = await query<{ status: string }>("select status from connector_approval_requests where owner_id=$1 and id=$2", [databaseOwnerId(ownerId), approvalId]);
  return row?.status ?? null;
}
