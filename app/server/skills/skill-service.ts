import "server-only";

import {
  SKILL_LIMITS,
  normalizeSkillName,
  parseSkillMutation,
  type SkillDefinition,
  type SkillMutation,
} from "../../../lib/skill-protocol";
import { BUILTIN_SKILLS, builtinSkill } from "./builtin-skills";
import {
  countCustomSkillRows,
  getSkillRow,
  insertCustomSkillRow,
  listSkillRows,
  resetBuiltinSkillRow,
  skillValue,
  softDeleteCustomSkillRow,
  updateSkillRow,
  upsertBuiltinSkillRow,
} from "./skill-repository";

export class SkillNotFoundError extends Error {}
export class BuiltinSkillDeleteError extends Error {}
export class CustomSkillLimitError extends Error {}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "23505");
}

function valuesForBuiltin(skill: (typeof BUILTIN_SKILLS)[number]): SkillMutation {
  return { name: skill.name, summary: skill.summary, instructions: skill.instructions };
}

async function ensureBuiltinSkills(ownerId: string): Promise<void> {
  for (const skill of BUILTIN_SKILLS) {
    await upsertBuiltinSkillRow(ownerId, {
      key: skill.key,
      version: skill.version,
      values: valuesForBuiltin(skill),
      normalizedName: normalizeSkillName(skill.name),
    });
  }
}

export async function listOwnerSkills(ownerId: string): Promise<SkillDefinition[]> {
  await ensureBuiltinSkills(ownerId);
  return (await listSkillRows(ownerId)).map(skillValue);
}

export async function readOwnerSkill(ownerId: string, skillId: string): Promise<SkillDefinition | null> {
  await ensureBuiltinSkills(ownerId);
  const row = await getSkillRow(ownerId, skillId);
  return row ? skillValue(row) : null;
}

export async function createOwnerSkill(ownerId: string, input: unknown): Promise<SkillDefinition> {
  const values = parseSkillMutation(input);
  if (await countCustomSkillRows(ownerId) >= SKILL_LIMITS.maxCustomSkills) {
    throw new CustomSkillLimitError(`You can create at most ${SKILL_LIMITS.maxCustomSkills} custom skills.`);
  }
  await ensureBuiltinSkills(ownerId);
  try {
    return skillValue(await insertCustomSkillRow(ownerId, values, normalizeSkillName(values.name)));
  } catch (error) {
    if (isUniqueViolation(error)) throw new Error("A skill with that name already exists.");
    throw error;
  }
}

export async function updateOwnerSkill(ownerId: string, skillId: string, input: unknown): Promise<SkillDefinition> {
  const values = parseSkillMutation(input);
  await ensureBuiltinSkills(ownerId);
  try {
    const row = await updateSkillRow(ownerId, skillId, values, normalizeSkillName(values.name));
    if (!row) throw new SkillNotFoundError("Skill not found.");
    return skillValue(row);
  } catch (error) {
    if (isUniqueViolation(error)) throw new Error("A skill with that name already exists.");
    throw error;
  }
}

export async function resetOwnerBuiltinSkill(ownerId: string, skillId: string): Promise<SkillDefinition> {
  await ensureBuiltinSkills(ownerId);
  const current = await getSkillRow(ownerId, skillId);
  if (!current) throw new SkillNotFoundError("Skill not found.");
  const builtin = current.builtin_key ? builtinSkill(current.builtin_key) : undefined;
  if (!builtin) throw new Error("Only built-in skills can be reset.");
  try {
    const row = await resetBuiltinSkillRow(ownerId, skillId, {
      key: builtin.key,
      version: builtin.version,
      values: valuesForBuiltin(builtin),
      normalizedName: normalizeSkillName(builtin.name),
    });
    if (!row) throw new SkillNotFoundError("Skill not found.");
    return skillValue(row);
  } catch (error) {
    if (isUniqueViolation(error)) throw new Error("A skill with the built-in name already exists.");
    throw error;
  }
}

export async function deleteOwnerCustomSkill(ownerId: string, skillId: string): Promise<void> {
  await ensureBuiltinSkills(ownerId);
  const current = await getSkillRow(ownerId, skillId);
  if (!current) throw new SkillNotFoundError("Skill not found.");
  if (current.builtin_key) throw new BuiltinSkillDeleteError("Built-in skills cannot be deleted.");
  if (!await softDeleteCustomSkillRow(ownerId, skillId)) throw new SkillNotFoundError("Skill not found.");
}
