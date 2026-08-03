import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  SKILL_LIMITS,
  normalizeSkillName,
  parseSkillMutation,
} from "../lib/skill-protocol.ts";
import { BUILTIN_SKILLS } from "../app/server/skills/builtin-skills.ts";
import { skillCatalogInstructions } from "../app/server/agent/skill-instructions.ts";
import { executeReadSkillTool } from "../app/server/agent/skill-tool.ts";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("skill mutations normalize fields and enforce the public limits", () => {
  assert.deepEqual(parseSkillMutation({
    name: "  Create   slides  ",
    summary: "  Makes slides.  ",
    instructions: "first\r\nsecond",
  }), {
    name: "Create slides",
    summary: "Makes slides.",
    instructions: "first\nsecond",
  });
  assert.equal(normalizeSkillName(" Create   PDF "), "create pdf");
  assert.throws(() => parseSkillMutation({ name: "", summary: "x", instructions: "x" }), /Name is required/);
  assert.throws(() => parseSkillMutation({
    name: "x",
    summary: "x",
    instructions: "x".repeat(SKILL_LIMITS.maxInstructionsLength + 1),
  }), /at most 12,000/);
});

test("built-in document skills contain the format workflows removed from the Python policy", () => {
  const pdf = BUILTIN_SKILLS.find(({ key }) => key === "create-pdf");
  const docx = BUILTIN_SKILLS.find(({ key }) => key === "create-docx");
  assert.match(pdf?.instructions ?? "", /run_python.*ReportLab/is);
  assert.match(pdf?.instructions ?? "", /exact PDF path in the artifacts array/i);
  assert.match(docx?.instructions ?? "", /run_python.*python-docx/is);
  assert.match(docx?.instructions ?? "", /exact DOCX path in the artifacts array/i);
  assert.match(pdf?.instructions ?? "", /reusable Python source/i);
  assert.match(docx?.instructions ?? "", /reusable Python source/i);
});

test("the system catalog includes metadata but omits full skill instructions", () => {
  const skills = [{
    id: "skill-1",
    name: "Create a PDF",
    summary: "Generate a PDF.",
    instructions: "SECRET FULL WORKFLOW",
    source: "builtin",
    customized: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }];
  const prompt = skillCatalogInstructions(skills);
  assert.match(prompt, /call read_skill with its exact id/i);
  assert.match(prompt, /skill-1.*Create a PDF.*Generate a PDF/s);
  assert.doesNotMatch(prompt, /SECRET FULL WORKFLOW/);
});

test("read_skill returns only an available requested skill", () => {
  const skill = {
    id: "skill-1",
    name: "Create a PDF",
    summary: "Generate a PDF.",
    instructions: "Full workflow",
    source: "builtin",
    customized: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const available = new Map([[skill.id, skill]]);
  const result = executeReadSkillTool({
    id: "call-1", name: "read_skill", arguments: '{"skillId":"skill-1"}',
  }, available);
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(result.stdout), {
    id: skill.id, name: skill.name, summary: skill.summary, instructions: skill.instructions,
  });
  assert.equal(executeReadSkillTool({
    id: "call-2", name: "read_skill", arguments: '{"skillId":"foreign"}',
  }, available).ok, false);
});

test("skill persistence and routes remain owner-scoped and server-only", async () => {
  const [migration, repository, route, itemRoute, resetRoute] = await Promise.all([
    source("supabase/migrations/20260730000000_user_skills.sql"),
    source("app/server/skills/skill-repository.ts"),
    source("app/api/skills/route.ts"),
    source("app/api/skills/[skillId]/route.ts"),
    source("app/api/skills/[skillId]/reset/route.ts"),
  ]);
  assert.match(migration, /owner_id uuid not null references auth\.users\(id\) on delete cascade/);
  assert.match(migration, /enable row level security/);
  assert.match(migration, /where deleted_at is null/);
  assert.match(repository, /where owner_id=\$1/);
  assert.match(repository, /databaseOwnerId\(ownerId\)/);
  assert.match(repository, /deleted_at is null/);
  assert.match(repository, /deleted_at=\$1/);
  for (const value of [route, itemRoute, resetRoute]) {
    assert.match(value, /authorizeOwnerSession/);
    assert.match(value, /status: 401/);
  }
  assert.match(route, /listOwnerSkills|createOwnerSkill/);
  assert.match(itemRoute, /updateOwnerSkill|deleteOwnerCustomSkill/);
  assert.match(resetRoute, /resetOwnerBuiltinSkill/);
});

test("Settings replaces Keyboard with an editable Skills accordion", async () => {
  const [settings, skills, styles] = await Promise.all([
    source("app/settings/settings-modal.tsx"),
    source("app/settings/skills-settings.tsx"),
    source("app/styles/settings.css"),
  ]);
  assert.match(settings, /id: "skills", label: "Skills"/);
  assert.match(settings, /activeSection === "skills"/);
  assert.match(settings, /<SkillsSettings/);
  assert.doesNotMatch(settings, /label: "Keyboard"/);
  assert.match(skills, /aria-expanded=\{expanded\}/);
  assert.match(skills, /Add skill/);
  assert.match(skills, /Reset to default/);
  assert.match(skills, /Delete this skill/);
  assert.match(styles, /\.skill-row-header/);
  assert.match(styles, /\.skill-expand:focus-visible/);
});
