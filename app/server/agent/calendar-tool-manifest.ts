import type { DeepSeekToolDefinition } from "../../providers/deepseek/deepseek-adapter";

export const CALENDAR_SKILL_KEY = "manage-google-calendar";
export const CALENDAR_TOOL_NAMES = {
  list: "list_calendar_events",
  get: "get_calendar_event",
  create: "create_calendar_event",
  update: "update_calendar_event",
  delete: "delete_calendar_event",
} as const;

const boundary = {
  oneOf: [
    {
      type: "object", additionalProperties: false, required: ["dateTime"],
      properties: { dateTime: { type: "string", description: "RFC 3339 date-time." }, timeZone: { type: "string", description: "Optional IANA time zone." } },
    },
    {
      type: "object", additionalProperties: false, required: ["date"],
      properties: { date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "All-day date. Event end dates are exclusive." } },
    },
  ],
} as const;

const mutableFields = {
  summary: { type: "string", minLength: 1, maxLength: 1024 },
  description: { type: "string", maxLength: 8192 },
  location: { type: "string", maxLength: 1024 },
  start: boundary,
  end: boundary,
} as const;

export const CALENDAR_TOOL_DEFINITIONS: DeepSeekToolDefinition[] = [
  {
    type: "function",
    function: {
      name: CALENDAR_TOOL_NAMES.list,
      description: "List events from the connected user's primary Google Calendar.",
      parameters: {
        type: "object", additionalProperties: false, required: ["timeMin", "timeMax"],
        properties: {
          timeMin: { type: "string", description: "Inclusive RFC 3339 lower bound." },
          timeMax: { type: "string", description: "Exclusive RFC 3339 upper bound." },
          query: { type: "string", maxLength: 500 },
          maxResults: { type: "integer", minimum: 1, maximum: 250 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: CALENDAR_TOOL_NAMES.get,
      description: "Read one event from the connected user's primary Google Calendar.",
      parameters: { type: "object", additionalProperties: false, required: ["eventId"], properties: { eventId: { type: "string", minLength: 1 } } },
    },
  },
  {
    type: "function",
    function: {
      name: CALENDAR_TOOL_NAMES.create,
      description: "Create an event on the connected user's primary Google Calendar.",
      parameters: { type: "object", additionalProperties: false, required: ["summary", "start", "end"], properties: mutableFields },
    },
  },
  {
    type: "function",
    function: {
      name: CALENDAR_TOOL_NAMES.update,
      description: "Edit an existing event on the connected user's primary Google Calendar.",
      parameters: {
        type: "object", additionalProperties: false, required: ["eventId"],
        properties: { eventId: { type: "string", minLength: 1 }, ...mutableFields },
      },
    },
  },
  {
    type: "function",
    function: {
      name: CALENDAR_TOOL_NAMES.delete,
      description: "Delete an event from the connected user's primary Google Calendar after an explicit user request.",
      parameters: { type: "object", additionalProperties: false, required: ["eventId"], properties: { eventId: { type: "string", minLength: 1 } } },
    },
  },
];

export function messageUnlocksCalendarTools(message: string): boolean {
  return /\b(?:calendar|calender|caldner|calnder)\b/i.test(message);
}
