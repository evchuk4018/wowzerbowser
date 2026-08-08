import "server-only";

import type { CustomToolDefinition, CustomToolSummary } from "../../../lib/custom-tool-protocol";
import { parseCustomToolMutation } from "../../../lib/custom-tool-protocol";
import { encryptCustomToolSecret } from "./custom-tool-crypto";
import {
  deleteCustomToolRow, getCustomTool, insertCustomTool, listCustomTools, removeCustomToolSecrets,
  updateCustomToolRow, upsertCustomToolSecrets,
} from "./custom-tool-repository";

export const RESERVED_TOOL_NAMES = new Set([
  "run_python", "web_search", "fetch_page", "check_time", "check_date", "check_location",
  "inspect_image", "search_document", "read_document_pages", "inspect_pdf_editability",
  "edit_source_backed_document", "edit_pdf", "compare_document_revisions", "phase_break",
  "read_skill", "create_skill", "update_skill",
]);

function assertAvailableName(name: string): void {
  if (RESERVED_TOOL_NAMES.has(name)) throw new Error("That tool name is reserved.");
}

function encryptedRows(secrets: Record<string, string>) {
  return Object.entries(secrets).map(([name, value]) => {
    const encrypted = encryptCustomToolSecret(value);
    return { name, ciphertext: encrypted.ciphertext, nonce: encrypted.nonce, auth_tag: encrypted.tag, fingerprint: encrypted.fingerprint };
  });
}

export async function listOwnerCustomTools(ownerId: string): Promise<CustomToolSummary[]> {
  return listCustomTools(ownerId);
}

export async function readOwnerCustomTool(ownerId: string, toolId: string): Promise<CustomToolDefinition | null> {
  return getCustomTool(ownerId, toolId);
}

export async function createOwnerCustomTool(ownerId: string, input: unknown): Promise<CustomToolDefinition> {
  const values = parseCustomToolMutation(input);
  assertAvailableName(values.name);
  const toolId = await insertCustomTool(ownerId, {
    name: values.name, description: values.description, instructions: values.instructions,
    input_schema: values.inputSchema, python_source: values.pythonSource, enabled: false,
  });
  try {
    await upsertCustomToolSecrets(ownerId, toolId, encryptedRows(values.secrets ?? {}));
  } catch (error) {
    await deleteCustomToolRow(ownerId, toolId).catch(() => undefined);
    throw error;
  }
  return (await getCustomTool(ownerId, toolId))!;
}

export async function updateOwnerCustomTool(ownerId: string, toolId: string, input: unknown): Promise<CustomToolDefinition | null> {
  const values = parseCustomToolMutation(input, true);
  assertAvailableName(values.name);
  const existing = await getCustomTool(ownerId, toolId);
  if (!existing) return null;
  const updated = await updateCustomToolRow(ownerId, toolId, {
    name: values.name, description: values.description, instructions: values.instructions,
    input_schema: values.inputSchema, python_source: values.pythonSource,
    enabled: values.enabled ?? existing.enabled,
  });
  if (!updated) return null;
  await removeCustomToolSecrets(ownerId, toolId, values.removeSecrets ?? []);
  await upsertCustomToolSecrets(ownerId, toolId, encryptedRows(values.secrets ?? {}));
  return getCustomTool(ownerId, toolId);
}

export async function deleteOwnerCustomTool(ownerId: string, toolId: string): Promise<boolean> {
  return deleteCustomToolRow(ownerId, toolId);
}
