import "server-only";

import type { SkillDefinition, SkillMutation } from "../../../lib/skill-protocol";
import { getServerClient } from "../../auth/supabase-server-adapter";

export type SkillRow = {
  id: string;
  owner_id: string;
  builtin_key: string | null;
  builtin_version: number | null;
  customized: boolean;
  name: string;
  normalized_name: string;
  summary: string;
  instructions: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

const columns = "id,owner_id,builtin_key,builtin_version,customized,name,normalized_name,summary,instructions,created_at,updated_at,deleted_at";
const db = () => getServerClient();

export function skillValue(row: SkillRow): SkillDefinition {
  return {
    id: row.id,
    ...(row.builtin_key ? { builtinKey: row.builtin_key } : {}),
    name: row.name,
    summary: row.summary,
    instructions: row.instructions,
    source: row.builtin_key ? "builtin" : "custom",
    customized: row.customized,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function upsertBuiltinSkillRow(ownerId: string, input: {
  key: string;
  version: number;
  values: SkillMutation;
  normalizedName: string;
}): Promise<void> {
  const existing = await db().from("user_skills").select(columns)
    .eq("owner_id", ownerId).eq("builtin_key", input.key).maybeSingle();
  if (existing.error) throw existing.error;
  const row = existing.data as SkillRow | null;
  if (!row) {
    const inserted = await db().from("user_skills").insert({
      owner_id: ownerId,
      builtin_key: input.key,
      builtin_version: input.version,
      customized: false,
      name: input.values.name,
      normalized_name: input.normalizedName,
      summary: input.values.summary,
      instructions: input.values.instructions,
    });
    if (inserted.error && inserted.error.code !== "23505") throw inserted.error;
    return;
  }
  if (row.customized || (row.builtin_version ?? 0) >= input.version) return;
  const updated = await db().from("user_skills").update({
    builtin_version: input.version,
    name: input.values.name,
    normalized_name: input.normalizedName,
    summary: input.values.summary,
    instructions: input.values.instructions,
    updated_at: new Date().toISOString(),
    deleted_at: null,
  }).eq("owner_id", ownerId).eq("id", row.id);
  if (updated.error) throw updated.error;
}

export async function listSkillRows(ownerId: string): Promise<SkillRow[]> {
  const result = await db().from("user_skills").select(columns)
    .eq("owner_id", ownerId).is("deleted_at", null)
    .order("builtin_key", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: true });
  if (result.error) throw result.error;
  return (result.data ?? []) as SkillRow[];
}

export async function getSkillRow(ownerId: string, skillId: string): Promise<SkillRow | null> {
  const result = await db().from("user_skills").select(columns)
    .eq("owner_id", ownerId).eq("id", skillId).is("deleted_at", null).maybeSingle();
  if (result.error) throw result.error;
  return result.data as SkillRow | null;
}

export async function countCustomSkillRows(ownerId: string): Promise<number> {
  const result = await db().from("user_skills").select("id", { count: "exact", head: true })
    .eq("owner_id", ownerId).is("builtin_key", null).is("deleted_at", null);
  if (result.error) throw result.error;
  return result.count ?? 0;
}

export async function insertCustomSkillRow(ownerId: string, values: SkillMutation, normalizedName: string): Promise<SkillRow> {
  const result = await db().from("user_skills").insert({
    owner_id: ownerId,
    builtin_key: null,
    builtin_version: null,
    customized: true,
    name: values.name,
    normalized_name: normalizedName,
    summary: values.summary,
    instructions: values.instructions,
  }).select(columns).single();
  if (result.error) throw result.error;
  return result.data as SkillRow;
}

export async function updateSkillRow(
  ownerId: string,
  skillId: string,
  values: SkillMutation,
  normalizedName: string,
): Promise<SkillRow | null> {
  const result = await db().from("user_skills").update({
    name: values.name,
    normalized_name: normalizedName,
    summary: values.summary,
    instructions: values.instructions,
    customized: true,
    updated_at: new Date().toISOString(),
  }).eq("owner_id", ownerId).eq("id", skillId).is("deleted_at", null).select(columns).maybeSingle();
  if (result.error) throw result.error;
  return result.data as SkillRow | null;
}

export async function resetBuiltinSkillRow(ownerId: string, skillId: string, input: {
  key: string;
  version: number;
  values: SkillMutation;
  normalizedName: string;
}): Promise<SkillRow | null> {
  const result = await db().from("user_skills").update({
    builtin_version: input.version,
    customized: false,
    name: input.values.name,
    normalized_name: input.normalizedName,
    summary: input.values.summary,
    instructions: input.values.instructions,
    updated_at: new Date().toISOString(),
    deleted_at: null,
  }).eq("owner_id", ownerId).eq("id", skillId).eq("builtin_key", input.key).select(columns).maybeSingle();
  if (result.error) throw result.error;
  return result.data as SkillRow | null;
}

export async function softDeleteCustomSkillRow(ownerId: string, skillId: string): Promise<boolean> {
  const result = await db().from("user_skills").update({
    deleted_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("owner_id", ownerId).eq("id", skillId).is("builtin_key", null).is("deleted_at", null).select("id").maybeSingle();
  if (result.error) throw result.error;
  return Boolean(result.data);
}
