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
    key: "create-and-edit-skills",
    version: 1,
    name: "Create and edit skills",
    summary: "Recognize reusable workflows, ask for missing details, and create or improve saved assistant skills.",
    instructions: `<skill>
Use this skill whenever the user asks to create, improve, edit, or manage a saved skill, or when the conversation reveals a clearly recurring workflow that would benefit from reusable instructions.

Create a skill for a repeatable workflow, not a one-off answer. Good candidates include recurring routines, such as practicing a Chinese conversation every day, and multi-step processes where the user wants the same behavior each time. Do not create a skill merely because a task is interesting, long, or used once. Do not duplicate an available skill: read the closest existing skill first and update it when the user's request is an improvement to that workflow.

Before creating a skill, inspect the available-skills catalog and read any plausible matches. Ask only for details that materially affect the result. Gather the intended outcome, when the skill should trigger, the workflow or constraints to follow, and what a useful response or artifact should contain. Infer harmless details from context and create the skill as soon as its purpose and behavior are sufficiently clear; do not ask for permission to save it. Use a concise name, a trigger-oriented summary, and self-contained imperative instructions that another assistant can follow without this conversation.

When the user changes an existing workflow, read the target skill first, preserve useful unrelated guidance, and update the complete skill rather than appending a vague note. Use create_skill for a new skill and update_skill for an existing one. Do not edit unrelated skills or this skill unless the user clearly asks for that change. After a successful mutation, tell the user what skill was created or updated and summarize its purpose.
</skill>`,
  },
  {
    key: "manage-google-calendar",
    version: 1,
    name: "Manage Google Calendar",
    summary: "Read, create, edit, and delete events in the connected primary Google Calendar.",
    instructions: `<skill>
Use this skill when the user asks to view or manage Google Calendar events.

The calendar tools operate only on the connected account's primary calendar. Use list_calendar_events for a time range and get_calendar_event for one exact event. Before editing or deleting, first list or get the event so its identity and current details are established. Delete only when the user explicitly asks to delete that event.

For timed events, use RFC 3339 dateTime values and include an IANA timeZone when it clarifies the user's intended local time. For all-day events, use date values; the end date is exclusive. Ask for missing dates, times, or timezone details when they materially affect the event. After a mutation, confirm the event title and effective date/time.
</skill>`,
  },
  {
    key: "manage-automations",
    version: 2,
    name: "Manage automations and reminders",
    summary: "Create and manage scheduled reports, conditional checks, and one-off reminders.",
    instructions: `<skill>
Use this skill when the user asks to create, view, change, pause, resume, cancel, or delete a recurring automation or one-off reminder.

Choose report when every scheduled run should create a chat, such as a daily news brief. Choose live_check when a chat should be created only after a measurable condition becomes true. Live checks pause after the first match.

For a one-off reminder, use create_reminder with a short title, the message to deliver verbatim, and a local YYYY-MM-DDTHH:mm time. Resolve relative dates in the user's IANA timezone. Use list_reminders or get_reminder before editing or cancelling, and keep completed or cancelled reminders visible as history.

Make the instructions self-contained: identify what to check, relevant sources or constraints, the exact condition for live checks, and what a useful result should contain. Use an explicit IANA timezone. If the user's timezone cannot be established, ask before creating a clock-time schedule. Intervals must be at least 15 minutes.

List or read existing automations before editing or deleting. After a mutation, clearly confirm the name, type, human-readable schedule, timezone, and active, paused, completed, or cancelled status.

Use create_automation to create the requested schedule as soon as all required details are known, including after a short follow-up answer supplies the timezone. The automation tools are built in; do not claim that a separate API, Python package, or sandbox call is needed.
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
