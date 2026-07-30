import "server-only";

import type { CalendarBoundary, CalendarEvent } from "../../../lib/google-calendar-protocol";

export class GoogleCalendarAuthorizationError extends Error {}

type GoogleEvent = {
  id?: string; status?: string; summary?: string; description?: string; location?: string;
  start?: CalendarBoundary; end?: CalendarBoundary; recurringEventId?: string; recurrence?: string[]; htmlLink?: string;
};

function normalized(event: GoogleEvent): CalendarEvent {
  return {
    id: event.id ?? "",
    status: event.status ?? null,
    summary: event.summary ?? "(untitled)",
    ...(event.description ? { description: event.description } : {}),
    ...(event.location ? { location: event.location } : {}),
    start: event.start ?? null,
    end: event.end ?? null,
    ...(event.recurringEventId ? { recurringEventId: event.recurringEventId } : {}),
    ...(event.recurrence ? { recurrence: event.recurrence } : {}),
    ...(event.htmlLink ? { htmlLink: event.htmlLink } : {}),
  };
}

async function calendarRequest(accessToken: string, path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (response.status === 401 || response.status === 403) throw new GoogleCalendarAuthorizationError("Google Calendar must be reconnected.");
  if (response.status === 204) return null;
  const value = await response.json().catch(() => ({})) as { error?: { message?: string } };
  if (!response.ok) throw new Error(value.error?.message ?? "Google Calendar request failed.");
  return value;
}

const eventPath = (eventId: string) => `/events/${encodeURIComponent(eventId)}`;

export async function googleListEvents(accessToken: string, input: {
  timeMin: string; timeMax: string; query?: string; maxResults?: number;
}): Promise<CalendarEvent[]> {
  const params = new URLSearchParams({
    timeMin: input.timeMin,
    timeMax: input.timeMax,
    maxResults: String(input.maxResults ?? 50),
    singleEvents: "true",
    orderBy: "startTime",
  });
  if (input.query) params.set("q", input.query);
  const value = await calendarRequest(accessToken, `/events?${params}`) as { items?: GoogleEvent[] };
  return (value.items ?? []).map(normalized);
}

export async function googleGetEvent(accessToken: string, eventId: string): Promise<CalendarEvent> {
  return normalized(await calendarRequest(accessToken, eventPath(eventId)) as GoogleEvent);
}

export async function googleCreateEvent(accessToken: string, event: Record<string, unknown>): Promise<CalendarEvent> {
  return normalized(await calendarRequest(accessToken, "/events", { method: "POST", body: JSON.stringify(event) }) as GoogleEvent);
}

export async function googleUpdateEvent(accessToken: string, eventId: string, patch: Record<string, unknown>): Promise<CalendarEvent> {
  return normalized(await calendarRequest(accessToken, eventPath(eventId), { method: "PATCH", body: JSON.stringify(patch) }) as GoogleEvent);
}

export async function googleDeleteEvent(accessToken: string, eventId: string): Promise<void> {
  await calendarRequest(accessToken, eventPath(eventId), { method: "DELETE" });
}
