import "server-only";

import type { SkillDefinition, SkillMutation } from "../../../lib/skill-protocol";
import { asIsoTimestamp, databaseOwnerId, query } from "../database/database";

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

export function skillValue(row: SkillRow): SkillDefinition {
  return {
    id: row.id,
    ...(row.builtin_key ? { builtinKey: row.builtin_key } : {}),
    name: row.name,
    summary: row.summary,
    instructions: row.instructions,
    source: row.builtin_key ? "builtin" : "custom",
    customized: row.customized,
    createdAt: asIsoTimestamp(row.created_at),
    updatedAt: asIsoTimestamp(row.updated_at),
  };
}

export async function upsertBuiltinSkillRow(ownerId: string, input: {
  key: string;
  version: number;
  values: SkillMutation;
  normalizedName: string;
}): Promise<void> {
  const owner = databaseOwnerId(ownerId);
  const [row] = await query<SkillRow>(`select ${columns} from user_skills where owner_id=$1 and builtin_key=$2`, [owner, input.key]);
  if (!row) {
    try {
      await query(`insert into user_skills(owner_id,builtin_key,builtin_version,customized,name,normalized_name,summary,instructions)
        values($1,$2,$3,false,$4,$5,$6,$7)`, [owner, input.key, input.version, input.values.name, input.normalizedName, input.values.summary, input.values.instructions]);
    } catch (error) {
      if ((error as { code?: string }).code !== "23505") throw error;
    }
    return;
  }
  if (row.customized || (row.builtin_version ?? 0) >= input.version) return;
  await query(`update user_skills set builtin_version=$1,name=$2,normalized_name=$3,summary=$4,instructions=$5,updated_at=$6,deleted_at=null
    where owner_id=$7 and id=$8`, [input.version, input.values.name, input.normalizedName, input.values.summary, input.values.instructions, new Date().toISOString(), owner, row.id]);
}

export async function listSkillRows(ownerId: string): Promise<SkillRow[]> {
  return query<SkillRow>(`select ${columns} from user_skills where owner_id=$1 and deleted_at is null order by builtin_key desc nulls last, created_at asc`, [databaseOwnerId(ownerId)]);
}

export async function getSkillRow(ownerId: string, skillId: string): Promise<SkillRow | null> {
  const [row] = await query<SkillRow>(`select ${columns} from user_skills where owner_id=$1 and id=$2 and deleted_at is null`, [databaseOwnerId(ownerId), skillId]);
  return row ?? null;
}

export async function countCustomSkillRows(ownerId: string): Promise<number> {
  const [row] = await query<{ count: number }>("select count(*)::int as count from user_skills where owner_id=$1 and builtin_key is null and deleted_at is null", [databaseOwnerId(ownerId)]);
  return Number(row?.count ?? 0);
}

export async function insertCustomSkillRow(ownerId: string, values: SkillMutation, normalizedName: string): Promise<SkillRow> {
  const [row] = await query<SkillRow>(`insert into user_skills(owner_id,customized,name,normalized_name,summary,instructions)
    values($1,true,$2,$3,$4,$5) returning ${columns}`, [databaseOwnerId(ownerId), values.name, normalizedName, values.summary, values.instructions]);
  return row;
}

export async function updateSkillRow(
  ownerId: string,
  skillId: string,
  values: SkillMutation,
  normalizedName: string,
): Promise<SkillRow | null> {
  const [row] = await query<SkillRow>(`update user_skills set name=$1,normalized_name=$2,summary=$3,instructions=$4,customized=true,updated_at=$5
    where owner_id=$6 and id=$7 and deleted_at is null returning ${columns}`, [values.name, normalizedName, values.summary, values.instructions, new Date().toISOString(), databaseOwnerId(ownerId), skillId]);
  return row ?? null;
}

export async function resetBuiltinSkillRow(ownerId: string, skillId: string, input: {
  key: string;
  version: number;
  values: SkillMutation;
  normalizedName: string;
}): Promise<SkillRow | null> {
  const [row] = await query<SkillRow>(`update user_skills set builtin_version=$1,customized=false,name=$2,normalized_name=$3,summary=$4,instructions=$5,updated_at=$6,deleted_at=null
    where owner_id=$7 and id=$8 and builtin_key=$9 returning ${columns}`, [input.version, input.values.name, input.normalizedName, input.values.summary, input.values.instructions, new Date().toISOString(), databaseOwnerId(ownerId), skillId, input.key]);
  return row ?? null;
}

export async function softDeleteCustomSkillRow(ownerId: string, skillId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(`update user_skills set deleted_at=$1,updated_at=$1
    where owner_id=$2 and id=$3 and builtin_key is null and deleted_at is null returning id`, [new Date().toISOString(), databaseOwnerId(ownerId), skillId]);
  return rows.length > 0;
}
