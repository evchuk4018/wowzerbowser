import type { DeepSeekToolDefinition } from "../../providers/deepseek/deepseek-adapter";

export const AUTOMATION_SKILL_KEY = "manage-automations";
export const AUTOMATION_TOOL_NAMES = {
  list: "list_automations", get: "get_automation", create: "create_automation",
  update: "update_automation", delete: "delete_automation",
} as const;

export function messageUnlocksAutomationTools(value: string): boolean {
  return /\b(automation|automations|automate|recurring|schedule[ds]?|every\s+(?:day|weekday|week|month|\d+\s+minutes?)|daily|weekly|pause|resume)\b/i.test(value);
}

const schedule = {
  oneOf: [
    { type: "object", additionalProperties: false, required: ["kind", "everyMinutes"], properties: { kind: { const: "interval" }, everyMinutes: { type: "integer", minimum: 15, maximum: 43200 } } },
    { type: "object", additionalProperties: false, required: ["kind", "localTime"], properties: { kind: { enum: ["daily", "weekdays"] }, localTime: { type: "string", pattern: "^([01]\\\\d|2[0-3]):[0-5]\\\\d$" } } },
    { type: "object", additionalProperties: false, required: ["kind", "localTime", "weekday"], properties: { kind: { const: "weekly" }, localTime: { type: "string" }, weekday: { type: "integer", minimum: 0, maximum: 6 } } },
  ],
} as const;
const fields = {
  name: { type: "string", minLength: 1, maxLength: 100 },
  kind: { enum: ["report", "live_check"] },
  instructions: { type: "string", minLength: 1, maxLength: 12000 },
  schedule,
  timeZone: { type: "string", minLength: 1, maxLength: 100 },
  status: { enum: ["active", "paused"] },
} as const;

export const AUTOMATION_TOOL_DEFINITIONS: DeepSeekToolDefinition[] = [
  { type: "function", function: { name: AUTOMATION_TOOL_NAMES.list, description: "List the user's recurring automations.", parameters: { type: "object", additionalProperties: false, properties: {} } } },
  { type: "function", function: { name: AUTOMATION_TOOL_NAMES.get, description: "Read one recurring automation.", parameters: { type: "object", additionalProperties: false, required: ["automationId"], properties: { automationId: { type: "string" } } } } },
  { type: "function", function: { name: AUTOMATION_TOOL_NAMES.create, description: "Create a recurring report or live check.", parameters: { type: "object", additionalProperties: false, required: ["name", "kind", "instructions", "schedule", "timeZone"], properties: fields } } },
  { type: "function", function: { name: AUTOMATION_TOOL_NAMES.update, description: "Edit, pause, or resume a recurring automation.", parameters: { type: "object", additionalProperties: false, required: ["automationId"], properties: { automationId: { type: "string" }, ...fields } } } },
  { type: "function", function: { name: AUTOMATION_TOOL_NAMES.delete, description: "Delete a recurring automation.", parameters: { type: "object", additionalProperties: false, required: ["automationId"], properties: { automationId: { type: "string" } } } } },
];
