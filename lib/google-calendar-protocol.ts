export type GoogleCalendarConnection = {
  connected: boolean;
  connectedAt: string | null;
  updatedAt: string | null;
};

export type CalendarBoundary =
  | { dateTime: string; timeZone?: string }
  | { date: string };

export type CalendarEvent = {
  id: string;
  status: string | null;
  summary: string;
  description?: string;
  location?: string;
  start: CalendarBoundary | null;
  end: CalendarBoundary | null;
  recurringEventId?: string;
  recurrence?: string[];
  htmlLink?: string;
};
