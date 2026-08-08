import type { DeepSeekToolDefinition } from "../../providers/deepseek/deepseek-adapter";

export const READ_SKILL_TOOL_NAME = "read_skill";
export const SKILL_TOOL_NAMES = {
  read: READ_SKILL_TOOL_NAME,
  create: "create_skill",
  update: "update_skill",
} as const;

export const SKILL_TOOL_DEFINITIONS: DeepSeekToolDefinition[] = [
  {
    type: "function",
    function: {
      name: READ_SKILL_TOOL_NAME,
      description: "Read the complete instructions for one available skill from the system skill catalog.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["skillId"],
        properties: {
          skillId: {
            type: "string",
            minLength: 1,
            maxLength: 100,
            description: "The exact skill ID shown in the available-skills catalog.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: SKILL_TOOL_NAMES.create,
      description: "Create a reusable owner skill once its purpose and workflow are sufficiently specified.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["name", "summary", "instructions"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 80, description: "A concise reusable skill name." },
          summary: { type: "string", minLength: 1, maxLength: 200, description: "When the assistant should use this skill." },
          instructions: { type: "string", minLength: 1, maxLength: 12000, description: "The complete self-contained workflow for the assistant." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: SKILL_TOOL_NAMES.update,
      description: "Edit an existing owner skill after reading it and preserving unrelated useful guidance.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["skillId", "name", "summary", "instructions"],
        properties: {
          skillId: { type: "string", minLength: 1, maxLength: 100, description: "The exact skill ID from the available-skills catalog." },
          name: { type: "string", minLength: 1, maxLength: 80, description: "The resulting skill name." },
          summary: { type: "string", minLength: 1, maxLength: 200, description: "The resulting use-case summary." },
          instructions: { type: "string", minLength: 1, maxLength: 12000, description: "The complete resulting workflow." },
        },
      },
    },
  },
];
