import type { DeepSeekToolDefinition } from "../../providers/deepseek/deepseek-adapter";

export const READ_SKILL_TOOL_NAME = "read_skill";

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
];
