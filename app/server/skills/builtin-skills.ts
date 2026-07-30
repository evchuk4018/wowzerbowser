import "server-only";

import type { SkillDefinition } from "../../../lib/skill-protocol";

export type BuiltinSkillDefinition = {
  key: string;
  version: number;
  name: string;
  summary: string;
  instructions: string;
};

export const BUILTIN_SKILLS: readonly BuiltinSkillDefinition[] = Object.freeze([
  {
    key: "manage-automations",
    version: 1,
    name: "Manage recurring automations",
    summary: "Create and manage scheduled reports and conditional live checks.",
    instructions: `<skill>
Use this skill when the user asks to create, view, change, pause, resume, or delete a recurring automation.

Choose report when every scheduled run should create a chat, such as a daily news brief. Choose live_check when a chat should be created only after a measurable condition becomes true. Live checks pause after the first match.

Make the instructions self-contained: identify what to check, relevant sources or constraints, the exact condition for live checks, and what a useful result should contain. Use an explicit IANA timezone. If the user's timezone cannot be established, ask before creating a clock-time schedule. Intervals must be at least 15 minutes.

List or read existing automations before editing or deleting. After a mutation, clearly confirm the name, type, human-readable schedule, timezone, and active or paused status.
</skill>`,
  },
  {
    key: "create-pdf",
    version: 1,
    name: "Create a PDF",
    summary: "Generate a downloadable, source-backed PDF with Python and ReportLab.",
    instructions: `<skill>
Use this skill when the user asks to create or generate a PDF.

Use the run_python tool and the preinstalled ReportLab package (import reportlab). Do not merely show Python source, install ReportLab, or make a separate package-probe call.

Create the PDF in one bounded project directory with a clearly named reusable Python source file and the requested PDF output. Keep any required local assets in that directory so the document can be rendered again.

In the same run_python call, execute the source, write the PDF to a safe relative path, and include that exact PDF path in the artifacts array. Prefer a descriptive filename supplied by the user; otherwise choose a concise filename ending in .pdf.

Do not claim the PDF was created until the tool result has ok: true and contains the expected PDF in artifacts. Inspect stderr and correct the generation call if execution fails or the artifact is missing.
</skill>`,
  },
  {
    key: "create-docx",
    version: 1,
    name: "Create a DOCX",
    summary: "Generate a downloadable, source-backed Word document with Python and python-docx.",
    instructions: `<skill>
Use this skill when the user asks to create or generate a Microsoft Word DOCX document.

Use the run_python tool and the preinstalled python-docx package (import docx). Do not merely show Python source, install python-docx, or make a separate package-probe call.

Create the DOCX in one bounded project directory with a clearly named reusable Python source file and the requested DOCX output. Keep any required local assets in that directory so the document can be rendered again.

In the same run_python call, execute the source, write the DOCX to a safe relative path, and include that exact DOCX path in the artifacts array. Prefer a descriptive filename supplied by the user; otherwise choose a concise filename ending in .docx.

Do not claim the DOCX was created until the tool result has ok: true and contains the expected DOCX in artifacts. Inspect stderr and correct the generation call if execution fails or the artifact is missing.
</skill>`,
  },
]);

export function builtinSkill(key: string): BuiltinSkillDefinition | undefined {
  return BUILTIN_SKILLS.find((skill) => skill.key === key);
}

export function builtinSkillFallbacks(): SkillDefinition[] {
  return BUILTIN_SKILLS.map((skill) => ({
    id: `builtin:${skill.key}`,
    builtinKey: skill.key,
    name: skill.name,
    summary: skill.summary,
    instructions: skill.instructions,
    source: "builtin",
    customized: false,
    createdAt: "",
    updatedAt: "",
  }));
}
