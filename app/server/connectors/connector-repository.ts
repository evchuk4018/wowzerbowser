import "server-only";

import { getServerClient } from "../../auth/supabase-server-adapter";
import type { ConnectorManifest } from "../../../lib/connector-protocol";

const client = () => getServerClient();

export type ConnectorDefinitionRow = {
  id: string; owner_id: string | null; name: string; description: string; icon_url: string | null;
  version: string; provider: "managed" | "remote_mcp"; auth_type: "oauth2" | "api_key" | "none";
  capabilities: unknown; default_approval: unknown; endpoint_url: string | null; health_status: string;
};
export type ConnectorConnectionRow = {
  id: string; owner_id: string; connector_id: string; account_label: string | null; account_email: string | null;
  status: string; is_default: boolean; credentials_ciphertext: string | null; credentials_nonce: string | null;
  credentials_auth_tag: string | null; credentials_fingerprint: string | null; metadata: Record<string, unknown>;
  connected_at: string; updated_at: string;
};
export type ConnectorToolRow = {
  id: string; owner_id: string | null; connector_id: string; connection_id: string | null; name: string;
  description: string; input_schema: Record<string, unknown>; access: "read" | "write" | "destructive";
  enabled: boolean; connector_version: string; discovered_at: string; updated_at: string;
};

export async function listCustomDefinitions(ownerId: string): Promise<ConnectorDefinitionRow[]> {
  const { data, error } = await client().from("connector_definitions").select("*").eq("owner_id", ownerId).order("name");
  if (error) throw error;
  return (data ?? []) as ConnectorDefinitionRow[];
}

export async function upsertDefinition(ownerId: string, values: Omit<ConnectorDefinitionRow, "owner_id" | "health_status"> & { endpoint_url?: string | null }): Promise<void> {
  const { error } = await client().from("connector_definitions").upsert({
    id: values.id, owner_id: ownerId, name: values.name, description: values.description, icon_url: values.icon_url,
    version: values.version, provider: values.provider, auth_type: values.auth_type, capabilities: values.capabilities,
    default_approval: values.default_approval, endpoint_url: values.endpoint_url ?? null, health_status: "unknown", updated_at: new Date().toISOString(),
  }, { onConflict: "id" });
  if (error) throw error;
}

export async function ensureManagedDefinition(manifest: ConnectorManifest): Promise<void> {
  const { error } = await client().from("connector_definitions").upsert({
    id: manifest.id, owner_id: null, name: manifest.name, description: manifest.description, icon_url: manifest.iconUrl ?? null,
    version: manifest.version, provider: manifest.provider, auth_type: manifest.auth.type, capabilities: manifest.capabilities,
    default_approval: manifest.defaultApproval, health_status: "unknown", updated_at: new Date().toISOString(),
  }, { onConflict: "id" });
  if (error) throw error;
}

export async function deleteDefinition(ownerId: string, connectorId: string): Promise<boolean> {
  const { data, error } = await client().from("connector_definitions").delete().eq("owner_id", ownerId).eq("id", connectorId).select("id");
  if (error) throw error;
  return Boolean(data?.length);
}

export async function ensureInstallation(ownerId: string, connectorId: string): Promise<void> {
  const { error } = await client().from("connector_installations").upsert({ owner_id: ownerId, connector_id: connectorId, enabled: true, updated_at: new Date().toISOString() }, { onConflict: "owner_id,connector_id" });
  if (error) throw error;
}

export async function getInstallation(ownerId: string, connectorId: string): Promise<{ enabled: boolean } | null> {
  const { data, error } = await client().from("connector_installations").select("enabled").eq("owner_id", ownerId).eq("connector_id", connectorId).maybeSingle();
  if (error) throw error;
  return data as { enabled: boolean } | null;
}

export async function listConnections(ownerId: string, connectorId: string): Promise<ConnectorConnectionRow[]> {
  const { data, error } = await client().from("connector_connections").select("*").eq("owner_id", ownerId).eq("connector_id", connectorId).neq("status", "disconnected").order("created_at");
  if (error) throw error;
  return (data ?? []) as ConnectorConnectionRow[];
}

export async function getConnection(ownerId: string, connectionId: string): Promise<ConnectorConnectionRow | null> {
  const { data, error } = await client().from("connector_connections").select("*").eq("owner_id", ownerId).eq("id", connectionId).maybeSingle();
  if (error) throw error;
  return data as ConnectorConnectionRow | null;
}

export async function getDefaultConnection(ownerId: string, connectorId: string): Promise<ConnectorConnectionRow | null> {
  const current = await client().from("connector_connections").select("*").eq("owner_id", ownerId).eq("connector_id", connectorId).eq("status", "connected").eq("is_default", true).maybeSingle();
  if (current.error) throw current.error;
  if (current.data) return current.data as ConnectorConnectionRow;
  const fallback = await client().from("connector_connections").select("*").eq("owner_id", ownerId).eq("connector_id", connectorId).eq("status", "connected").order("created_at").limit(1).maybeSingle();
  if (fallback.error) throw fallback.error;
  return fallback.data as ConnectorConnectionRow | null;
}

export async function insertConnection(ownerId: string, values: {
  connectorId: string; accountLabel?: string; accountEmail?: string; credentials: { ciphertext: string; nonce: string; authTag: string; fingerprint: string }; metadata?: Record<string, unknown>;
}): Promise<string> {
  const existing = await listConnections(ownerId, values.connectorId);
  const { data, error } = await client().from("connector_connections").insert({
    owner_id: ownerId, connector_id: values.connectorId, account_label: values.accountLabel ?? null, account_email: values.accountEmail ?? null,
    status: "connected", is_default: existing.length === 0, credentials_ciphertext: values.credentials.ciphertext, credentials_nonce: values.credentials.nonce,
    credentials_auth_tag: values.credentials.authTag, credentials_fingerprint: values.credentials.fingerprint, metadata: values.metadata ?? {},
  }).select("id").single();
  if (error) throw error;
  return data.id as string;
}

export async function setDefaultConnection(ownerId: string, connectorId: string, connectionId: string): Promise<void> {
  const now = new Date().toISOString();
  const first = await client().from("connector_connections").update({ is_default: false, updated_at: now }).eq("owner_id", ownerId).eq("connector_id", connectorId);
  if (first.error) throw first.error;
  const second = await client().from("connector_connections").update({ is_default: true, updated_at: now }).eq("owner_id", ownerId).eq("connector_id", connectorId).eq("id", connectionId).eq("status", "connected");
  if (second.error) throw second.error;
}

export async function markConnection(ownerId: string, connectionId: string, status: "connected" | "reconnect_required" | "unavailable" | "disconnected"): Promise<void> {
  const { error } = await client().from("connector_connections").update({ status, updated_at: new Date().toISOString() }).eq("owner_id", ownerId).eq("id", connectionId);
  if (error) throw error;
}

export async function deleteConnection(ownerId: string, connectionId: string): Promise<void> {
  const { error } = await client().from("connector_connections").delete().eq("owner_id", ownerId).eq("id", connectionId);
  if (error) throw error;
}

export async function listTools(ownerId: string, connectorId: string): Promise<ConnectorToolRow[]> {
  const { data, error } = await client().from("connector_tools").select("*").eq("connector_id", connectorId).or(`owner_id.eq.${ownerId},owner_id.is.null`).order("name");
  if (error) throw error;
  return (data ?? []) as ConnectorToolRow[];
}

export async function upsertTools(ownerId: string, connectorId: string, connectionId: string | null, tools: Array<Omit<ConnectorToolRow, "id" | "owner_id" | "connector_id" | "connection_id" | "updated_at"> & { name: string }>): Promise<void> {
  if (!tools.length) return;
  const { error } = await client().from("connector_tools").upsert(tools.map((tool) => ({
    owner_id: ownerId, connector_id: connectorId, connection_id: connectionId, name: tool.name, description: tool.description,
    input_schema: tool.input_schema, access: tool.access, enabled: tool.enabled, connector_version: tool.connector_version,
    discovered_at: tool.discovered_at, updated_at: new Date().toISOString(),
  })), { onConflict: "owner_id,connector_id,connection_id,name" });
  if (error) throw error;
}

export async function updateTool(ownerId: string, connectorId: string, toolName: string, enabled: boolean): Promise<boolean> {
  const { data, error } = await client().from("connector_tools").update({ enabled, updated_at: new Date().toISOString() }).eq("owner_id", ownerId).eq("connector_id", connectorId).eq("name", toolName).select("id");
  if (error) throw error;
  return Boolean(data?.length);
}

export async function getPermission(ownerId: string, connectorId: string, toolName: string): Promise<{ enabled: boolean; approval_mode: "never" | "always" } | null> {
  const { data, error } = await client().from("connector_permissions").select("enabled,approval_mode").eq("owner_id", ownerId).eq("connector_id", connectorId).eq("tool_name", toolName).maybeSingle();
  if (error) throw error;
  return data as { enabled: boolean; approval_mode: "never" | "always" } | null;
}

export async function setPermission(ownerId: string, connectorId: string, toolName: string, values: { enabled?: boolean; approvalMode?: "never" | "always" }): Promise<void> {
  const current = await getPermission(ownerId, connectorId, toolName);
  const { error } = await client().from("connector_permissions").upsert({
    owner_id: ownerId, connector_id: connectorId, tool_name: toolName, enabled: values.enabled ?? current?.enabled ?? true,
    approval_mode: values.approvalMode ?? current?.approval_mode ?? "always", updated_at: new Date().toISOString(),
  }, { onConflict: "owner_id,connector_id,tool_name" });
  if (error) throw error;
}

export async function logCall(values: { ownerId: string; connectorId: string; connectionId: string; toolName: string; access: string; arguments: Record<string, unknown>; ok: boolean; errorCode?: string; durationMs: number }): Promise<void> {
  const { error } = await client().from("connector_call_logs").insert({ owner_id: values.ownerId, connector_id: values.connectorId, connection_id: values.connectionId, tool_name: values.toolName, access: values.access, arguments: values.arguments, ok: values.ok, error_code: values.errorCode ?? null, duration_ms: values.durationMs });
  if (error) throw error;
}

export async function createApproval(values: { ownerId: string; jobId?: string; conversationId?: string; connectorId: string; connectionId: string; toolName: string; description: string; access: string; importantArguments: Record<string, unknown> }): Promise<string> {
  const { data, error } = await client().from("connector_approval_requests").insert({ owner_id: values.ownerId, job_id: values.jobId ?? null, conversation_id: values.conversationId ?? null, connector_id: values.connectorId, connection_id: values.connectionId, tool_name: values.toolName, description: values.description, access: values.access, important_arguments: values.importantArguments }).select("id").single();
  if (error) throw error;
  return data.id as string;
}

export async function getApproval(ownerId: string, approvalId: string) {
  const { data, error } = await client().from("connector_approval_requests").select("*").eq("owner_id", ownerId).eq("id", approvalId).maybeSingle();
  if (error) throw error;
  return data as { id: string; owner_id: string; job_id: string | null; conversation_id: string | null; connector_id: string; connection_id: string; tool_name: string; description: string; access: "read" | "write" | "destructive"; important_arguments: Record<string, unknown>; status: string; created_at: string } | null;
}

export async function resolveApproval(ownerId: string, approvalId: string, status: "allow_once" | "always_allow" | "deny"): Promise<boolean> {
  const { data, error } = await client().from("connector_approval_requests").update({ status, resolved_at: new Date().toISOString() }).eq("owner_id", ownerId).eq("id", approvalId).eq("status", "pending").select("id");
  if (error) throw error;
  return Boolean(data?.length);
}

export async function readApprovalStatus(ownerId: string, approvalId: string): Promise<string | null> {
  const { data, error } = await client().from("connector_approval_requests").select("status").eq("owner_id", ownerId).eq("id", approvalId).maybeSingle();
  if (error) throw error;
  return (data as { status: string } | null)?.status ?? null;
}
