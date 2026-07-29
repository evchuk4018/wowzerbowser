export const SKILL_LIMITS = Object.freeze({
  maxNameLength: 80,
  maxSummaryLength: 200,
  maxInstructionsLength: 12_000,
  maxCustomSkills: 25,
});

export type SkillSource = "builtin" | "custom";

export type SkillDefinition = {
  id: string;
  name: string;
  summary: string;
  instructions: string;
  source: SkillSource;
  customized: boolean;
  createdAt: string;
  updatedAt: string;
};

export type SkillCatalogEntry = Pick<SkillDefinition, "id" | "name" | "summary">;

export type SkillMutation = {
  name: string;
  summary: string;
  instructions: string;
};

function normalized(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  const result = value.replace(/\r\n?/g, "\n").trim();
  if (!result) throw new Error(`${field} is required.`);
  if (result.length > maximum) throw new Error(`${field} must be at most ${maximum.toLocaleString("en-US")} characters.`);
  return result;
}

export function normalizeSkillName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

export function parseSkillMutation(input: unknown): SkillMutation {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Skill input must be an object.");
  const value = input as Record<string, unknown>;
  return {
    name: normalized(value.name, "Name", SKILL_LIMITS.maxNameLength).replace(/\s+/g, " "),
    summary: normalized(value.summary, "Summary", SKILL_LIMITS.maxSummaryLength).replace(/\s+/g, " "),
    instructions: normalized(value.instructions, "Instructions", SKILL_LIMITS.maxInstructionsLength),
  };
}
