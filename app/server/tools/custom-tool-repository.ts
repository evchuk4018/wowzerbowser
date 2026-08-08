import "server-only";

import type { CustomToolDefinition, CustomToolSummary, JsonSchema } from "../../../lib/custom-tool-protocol";
import { databaseOwnerId, isoTimestamp, jsonb, query } from "../database/database";

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
    createdAt: isoTimestamp(row.created_at), updatedAt: isoTimestamp(row.updated_at),
    secrets: secrets.filter((item) => item.tool_id === row.id).map((item) => ({
      name: item.name, configured: true, fingerprint: item.fingerprint,
    })),
  };
}

async function secretRows(ownerId: string, toolIds?: string[]): Promise<SecretRow[]> {
  if (toolIds && !toolIds.length) return [];
  if (toolIds) return query<SecretRow>("select tool_id,owner_id,name,ciphertext,nonce,auth_tag,fingerprint from custom_tool_secrets where owner_id=$1 and tool_id=any($2::uuid[])", [databaseOwnerId(ownerId), toolIds]);
  return query<SecretRow>("select tool_id,owner_id,name,ciphertext,nonce,auth_tag,fingerprint from custom_tool_secrets where owner_id=$1", [databaseOwnerId(ownerId)]);
}

export async function listCustomTools(ownerId: string): Promise<CustomToolSummary[]> {
  const rows = await query<ToolRow>("select id,owner_id,name,description,instructions,input_schema,python_source,enabled,created_at,updated_at from custom_tools where owner_id=$1 order by updated_at desc", [databaseOwnerId(ownerId)]);
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
  const [row] = await query<ToolRow>("select id,owner_id,name,description,instructions,input_schema,python_source,enabled,created_at,updated_at from custom_tools where owner_id=$1 and id=$2", [databaseOwnerId(ownerId), toolId]);
  if (!row) return null;
  return definition(row, await secretRows(ownerId, [toolId]));
}

export async function getExecutableCustomTool(ownerId: string, toolId: string): Promise<ExecutableCustomTool | null> {
  const item = await getCustomTool(ownerId, toolId);
  return item ? { ...item, encryptedSecrets: await secretRows(ownerId, [toolId]) } : null;
}

export async function listEnabledExecutableTools(ownerId: string): Promise<ExecutableCustomTool[]> {
  const rows = await query<ToolRow>("select id,owner_id,name,description,instructions,input_schema,python_source,enabled,created_at,updated_at from custom_tools where owner_id=$1 and enabled=true order by name", [databaseOwnerId(ownerId)]);
  const secrets = await secretRows(ownerId, rows.map((row) => row.id));
  return rows.map((row) => ({ ...definition(row, secrets), encryptedSecrets: secrets.filter((item) => item.tool_id === row.id) }));
}

export async function insertCustomTool(ownerId: string, values: Omit<ToolRow, "id" | "owner_id" | "created_at" | "updated_at">): Promise<string> {
  const [row] = await query<{ id: string }>("insert into custom_tools(owner_id,name,description,instructions,input_schema,python_source,enabled) values($1,$2,$3,$4,$5::jsonb,$6,$7) returning id", [databaseOwnerId(ownerId), values.name, values.description, values.instructions, jsonb(values.input_schema), values.python_source, values.enabled]);
  return row.id;
}

export async function updateCustomToolRow(ownerId: string, toolId: string, values: Omit<ToolRow, "id" | "owner_id" | "created_at" | "updated_at">): Promise<boolean> {
  const rows = await query<{ id: string }>("update custom_tools set name=$1,description=$2,instructions=$3,input_schema=$4::jsonb,python_source=$5,enabled=$6,updated_at=$7 where owner_id=$8 and id=$9 returning id", [values.name, values.description, values.instructions, jsonb(values.input_schema), values.python_source, values.enabled, new Date().toISOString(), databaseOwnerId(ownerId), toolId]);
  return rows.length > 0;
}

export async function upsertCustomToolSecrets(ownerId: string, toolId: string, rows: Omit<SecretRow, "tool_id" | "owner_id">[]): Promise<void> {
  if (!rows.length) return;
  const owner = databaseOwnerId(ownerId);
  for (const row of rows) await query(`insert into custom_tool_secrets(tool_id,owner_id,name,ciphertext,nonce,auth_tag,fingerprint,updated_at)
    values($1,$2,$3,$4,$5,$6,$7,$8) on conflict(tool_id,name) do update set owner_id=excluded.owner_id,ciphertext=excluded.ciphertext,nonce=excluded.nonce,auth_tag=excluded.auth_tag,fingerprint=excluded.fingerprint,updated_at=excluded.updated_at`, [toolId, owner, row.name, row.ciphertext, row.nonce, row.auth_tag, row.fingerprint, new Date().toISOString()]);
}

export async function removeCustomToolSecrets(ownerId: string, toolId: string, names: string[]): Promise<void> {
  if (!names.length) return;
  await query("delete from custom_tool_secrets where owner_id=$1 and tool_id=$2 and name=any($3::text[])", [databaseOwnerId(ownerId), toolId, names]);
}

export async function deleteCustomToolRow(ownerId: string, toolId: string): Promise<boolean> {
  const rows = await query<{ id: string }>("delete from custom_tools where owner_id=$1 and id=$2 returning id", [databaseOwnerId(ownerId), toolId]);
  return rows.length > 0;
}
