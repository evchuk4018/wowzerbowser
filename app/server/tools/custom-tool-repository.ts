import "server-only";

import type { CustomToolDefinition, CustomToolSummary, JsonSchema } from "../../../lib/custom-tool-protocol";
import { getServerClient } from "../../auth/supabase-server-adapter";

type ToolRow = {
  id: string; owner_id: string; name: string; description: string; instructions: string;
  input_schema: JsonSchema; python_source: string; enabled: boolean; created_at: string; updated_at: string;
};
export type SecretRow = {
  tool_id: string; owner_id: string; name: string; ciphertext: string; nonce: string;
  auth_tag: string; fingerprint: string;
};
export type ExecutableCustomTool = CustomToolDefinition & { encryptedSecrets: SecretRow[] };

function definition(row: ToolRow, secrets: SecretRow[]): CustomToolDefinition {
  return {
    id: row.id, name: row.name, description: row.description, instructions: row.instructions,
    inputSchema: row.input_schema, pythonSource: row.python_source, enabled: row.enabled,
    createdAt: row.created_at, updatedAt: row.updated_at,
    secrets: secrets.filter((item) => item.tool_id === row.id).map((item) => ({
      name: item.name, configured: true, fingerprint: item.fingerprint,
    })),
  };
}

async function secretRows(ownerId: string, toolIds?: string[]): Promise<SecretRow[]> {
  if (toolIds && !toolIds.length) return [];
  let query = getServerClient().from("custom_tool_secrets")
    .select("tool_id,owner_id,name,ciphertext,nonce,auth_tag,fingerprint").eq("owner_id", ownerId);
  if (toolIds) query = query.in("tool_id", toolIds);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as SecretRow[];
}

export async function listCustomTools(ownerId: string): Promise<CustomToolSummary[]> {
  const { data, error } = await getServerClient().from("custom_tools")
    .select("id,owner_id,name,description,instructions,input_schema,python_source,enabled,created_at,updated_at")
    .eq("owner_id", ownerId).order("updated_at", { ascending: false });
  if (error) throw error;
  const rows = (data ?? []) as ToolRow[];
  const secrets = await secretRows(ownerId, rows.map((row) => row.id));
  return rows.map((row) => {
    const item = definition(row, secrets);
    return {
      id: item.id, name: item.name, description: item.description, enabled: item.enabled,
      secrets: item.secrets, createdAt: item.createdAt, updatedAt: item.updatedAt,
    };
  });
}

export async function getCustomTool(ownerId: string, toolId: string): Promise<CustomToolDefinition | null> {
  const { data, error } = await getServerClient().from("custom_tools")
    .select("id,owner_id,name,description,instructions,input_schema,python_source,enabled,created_at,updated_at")
    .eq("owner_id", ownerId).eq("id", toolId).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return definition(data as ToolRow, await secretRows(ownerId, [toolId]));
}

export async function getExecutableCustomTool(ownerId: string, toolId: string): Promise<ExecutableCustomTool | null> {
  const item = await getCustomTool(ownerId, toolId);
  return item ? { ...item, encryptedSecrets: await secretRows(ownerId, [toolId]) } : null;
}

export async function listEnabledExecutableTools(ownerId: string): Promise<ExecutableCustomTool[]> {
  const { data, error } = await getServerClient().from("custom_tools")
    .select("id,owner_id,name,description,instructions,input_schema,python_source,enabled,created_at,updated_at")
    .eq("owner_id", ownerId).eq("enabled", true).order("name");
  if (error) throw error;
  const rows = (data ?? []) as ToolRow[];
  const secrets = await secretRows(ownerId, rows.map((row) => row.id));
  return rows.map((row) => ({ ...definition(row, secrets), encryptedSecrets: secrets.filter((item) => item.tool_id === row.id) }));
}

export async function insertCustomTool(ownerId: string, values: Omit<ToolRow, "id" | "owner_id" | "created_at" | "updated_at">): Promise<string> {
  const { data, error } = await getServerClient().from("custom_tools").insert({
    owner_id: ownerId, name: values.name, description: values.description, instructions: values.instructions,
    input_schema: values.input_schema, python_source: values.python_source, enabled: values.enabled,
  }).select("id").single();
  if (error) throw error;
  return data.id as string;
}

export async function updateCustomToolRow(ownerId: string, toolId: string, values: Omit<ToolRow, "id" | "owner_id" | "created_at" | "updated_at">): Promise<boolean> {
  const { data, error } = await getServerClient().from("custom_tools").update({
    name: values.name, description: values.description, instructions: values.instructions,
    input_schema: values.input_schema, python_source: values.python_source, enabled: values.enabled,
    updated_at: new Date().toISOString(),
  }).eq("owner_id", ownerId).eq("id", toolId).select("id");
  if (error) throw error;
  return Boolean(data?.length);
}

export async function upsertCustomToolSecrets(ownerId: string, toolId: string, rows: Omit<SecretRow, "tool_id" | "owner_id">[]): Promise<void> {
  if (!rows.length) return;
  const { error } = await getServerClient().from("custom_tool_secrets").upsert(rows.map((row) => ({
    tool_id: toolId, owner_id: ownerId, name: row.name, ciphertext: row.ciphertext,
    nonce: row.nonce, auth_tag: row.auth_tag, fingerprint: row.fingerprint, updated_at: new Date().toISOString(),
  })), { onConflict: "tool_id,name" });
  if (error) throw error;
}

export async function removeCustomToolSecrets(ownerId: string, toolId: string, names: string[]): Promise<void> {
  if (!names.length) return;
  const { error } = await getServerClient().from("custom_tool_secrets").delete()
    .eq("owner_id", ownerId).eq("tool_id", toolId).in("name", names);
  if (error) throw error;
}

export async function deleteCustomToolRow(ownerId: string, toolId: string): Promise<boolean> {
  const { data, error } = await getServerClient().from("custom_tools").delete()
    .eq("owner_id", ownerId).eq("id", toolId).select("id");
  if (error) throw error;
  return Boolean(data?.length);
}
