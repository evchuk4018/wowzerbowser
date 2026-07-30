import "server-only";

import type { ChatToolCall, ChatToolResult } from "../../../lib/chat-protocol";
import {
  createCalendarEvent, deleteCalendarEvent, getCalendarEvent, listCalendarEvents, updateCalendarEvent,
} from "../calendar/google-calendar-service";
import { CALENDAR_TOOL_NAMES } from "./calendar-tool-manifest";

const failure = (call: ChatToolCall, stderr: string): ChatToolResult => ({
  id: call.id, name: call.name, ok: false, stdout: "", stderr,
});

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}

function boundary(value: unknown, name: string): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be a calendar date or date-time.`);
  const item = value as Record<string, unknown>;
  const keys = Object.keys(item);
  if (typeof item.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item.date) && keys.length === 1) {
    const date = new Date(`${item.date}T00:00:00Z`);
    if (!Number.isNaN(date.valueOf()) && date.toISOString().startsWith(item.date)) return { date: item.date };
  }
  if (typeof item.dateTime === "string" && !Number.isNaN(Date.parse(item.dateTime))
    && keys.every((key) => key === "dateTime" || key === "timeZone")
    && (item.timeZone === undefined || (typeof item.timeZone === "string" && item.timeZone.trim()))) {
    return {
      dateTime: item.dateTime,
      ...(typeof item.timeZone === "string" ? { timeZone: item.timeZone.trim() } : {}),
    };
  }
  throw new Error(`${name} must contain either a valid date or RFC 3339 dateTime.`);
}

function eventFields(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const key of ["summary", "description", "location"] as const) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== "string") throw new Error(`${key} must be a string.`);
    output[key] = input[key];
  }
  if (input.start !== undefined) output.start = boundary(input.start, "start");
  if (input.end !== undefined) output.end = boundary(input.end, "end");
  return output;
}

export async function executeCalendarTool(call: ChatToolCall, ownerId: string): Promise<ChatToolResult> {
  try {
    const input = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
    let output: unknown;
    if (call.name === CALENDAR_TOOL_NAMES.list) {
      const timeMin = requiredString(input.timeMin, "timeMin");
      const timeMax = requiredString(input.timeMax, "timeMax");
      if (Number.isNaN(Date.parse(timeMin)) || Number.isNaN(Date.parse(timeMax))) throw new Error("timeMin and timeMax must be RFC 3339 date-times.");
      if (Date.parse(timeMin) >= Date.parse(timeMax)) throw new Error("timeMax must be after timeMin.");
      if (input.query !== undefined && typeof input.query !== "string") throw new Error("query must be a string.");
      if (input.maxResults !== undefined && (!Number.isInteger(input.maxResults) || (input.maxResults as number) < 1 || (input.maxResults as number) > 250)) {
        throw new Error("maxResults must be an integer from 1 to 250.");
      }
      output = await listCalendarEvents(ownerId, {
        timeMin,
        timeMax,
        ...(typeof input.query === "string" && input.query ? { query: input.query } : {}),
        ...(typeof input.maxResults === "number" ? { maxResults: input.maxResults } : {}),
      });
    } else if (call.name === CALENDAR_TOOL_NAMES.get) {
      output = await getCalendarEvent(ownerId, requiredString(input.eventId, "eventId"));
    } else if (call.name === CALENDAR_TOOL_NAMES.create) {
      const fields = eventFields(input);
      requiredString(fields.summary, "summary");
      if (!fields.start || !fields.end) throw new Error("start and end are required.");
      output = await createCalendarEvent(ownerId, fields);
    } else if (call.name === CALENDAR_TOOL_NAMES.update) {
      const eventId = requiredString(input.eventId, "eventId");
      const fields = eventFields(input);
      if (!Object.keys(fields).length) throw new Error("At least one event field is required.");
      output = await updateCalendarEvent(ownerId, eventId, fields);
    } else if (call.name === CALENDAR_TOOL_NAMES.delete) {
      await deleteCalendarEvent(ownerId, requiredString(input.eventId, "eventId"));
      output = { deleted: true };
    } else return failure(call, `Unknown calendar tool: ${call.name}`);
    return { id: call.id, name: call.name, ok: true, stdout: JSON.stringify(output), stderr: "" };
  } catch (error) {
    return failure(call, error instanceof Error ? error.message : "Google Calendar operation failed.");
  }
}
