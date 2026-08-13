import type { DeepSeekToolDefinition } from "../../providers/deepseek/deepseek-adapter";

export const AUTOMATION_SKILL_KEY = "manage-automations";
export const AUTOMATION_TOOL_NAMES = {
  list: "list_automations", get: "get_automation", create: "create_automation",
  update: "update_automation", delete: "delete_automation",
} as const;
export const REMINDER_TOOL_NAMES = {
  list: "list_reminders", get: "get_reminder", create: "create_reminder",
  update: "update_reminder", cancel: "cancel_reminder",
} as const;

export function messageUnlocksAutomationTools(value: string): boolean {
  return /\b(automation|automations|automate|recurring|schedule[ds]?|every\s+(?:day|weekday|week|month|\d+\s+minutes?)|daily|weekly|pause|resume|remind(?:er|ers)?|one[- ]off)\b/i.test(value);
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
const reminderFields = {
  title: { type: "string", minLength: 1, maxLength: 100 },
  message: { type: "string", minLength: 1, maxLength: 12000 },
  at: { type: "string", minLength: 16, maxLength: 64, description: "Local date and time in YYYY-MM-DDTHH:mm format." },
  timeZone: { type: "string", minLength: 1, maxLength: 100, description: "IANA timezone; omit to use the user's timezone." },
  status: { enum: ["active", "paused"] },
} as const;

export function reminderInstructionsFor(timeZone?: string): string {
  let current = "unknown";
  if (timeZone) {
    try {
      current = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        dateStyle: "full",
        timeStyle: "short",
      }).format(new Date());
    } catch {
      current = "unknown";
    }
  }
  return [
    "For one-off reminders, use the reminder tools rather than a recurring automation.",
    `The user's IANA timezone is ${timeZone || "not available"}; their current local date and time is ${current}.`,
    "Resolve words such as today, tomorrow, and next Monday in that timezone, then send create_reminder with at as local YYYY-MM-DDTHH:mm and omit timeZone when the user's timezone is available.",
    "A reminder's message is delivered verbatim at the scheduled time. List or get reminders before editing or cancelling them.",
  ].join(" ");
}

export const AUTOMATION_TOOL_DEFINITIONS: DeepSeekToolDefinition[] = [
  { type: "function", function: { name: AUTOMATION_TOOL_NAMES.list, description: "List the user's recurring automations.", parameters: { type: "object", additionalProperties: false, properties: {} } } },
  { type: "function", function: { name: AUTOMATION_TOOL_NAMES.get, description: "Read one recurring automation.", parameters: { type: "object", additionalProperties: false, required: ["automationId"], properties: { automationId: { type: "string" } } } } },
  { type: "function", function: { name: AUTOMATION_TOOL_NAMES.create, description: "Create a recurring report or live check.", parameters: { type: "object", additionalProperties: false, required: ["name", "kind", "instructions", "schedule", "timeZone"], properties: fields } } },
  { type: "function", function: { name: AUTOMATION_TOOL_NAMES.update, description: "Edit, pause, or resume a recurring automation.", parameters: { type: "object", additionalProperties: false, required: ["automationId"], properties: { automationId: { type: "string" }, ...fields } } } },
  { type: "function", function: { name: AUTOMATION_TOOL_NAMES.delete, description: "Delete a recurring automation.", parameters: { type: "object", additionalProperties: false, required: ["automationId"], properties: { automationId: { type: "string" } } } } },
  { type: "function", function: { name: REMINDER_TOOL_NAMES.list, description: "List the user's one-off reminders, including completed and cancelled reminders.", parameters: { type: "object", additionalProperties: false, properties: {} } } },
  { type: "function", function: { name: REMINDER_TOOL_NAMES.get, description: "Read one one-off reminder.", parameters: { type: "object", additionalProperties: false, required: ["reminderId"], properties: { reminderId: { type: "string" } } } } },
  { type: "function", function: { name: REMINDER_TOOL_NAMES.create, description: "Create a one-off reminder for a specific local date and time.", parameters: { type: "object", additionalProperties: false, required: ["title", "message", "at"], properties: reminderFields } } },
  { type: "function", function: { name: REMINDER_TOOL_NAMES.update, description: "Edit, pause, or resume a one-off reminder.", parameters: { type: "object", additionalProperties: false, required: ["reminderId"], properties: { reminderId: { type: "string" }, ...reminderFields } } } },
  { type: "function", function: { name: REMINDER_TOOL_NAMES.cancel, description: "Cancel a one-off reminder without deleting its history.", parameters: { type: "object", additionalProperties: false, required: ["reminderId"], properties: { reminderId: { type: "string" } } } } },
];
