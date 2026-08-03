import type { GoogleCalendarConnection } from "../../lib/google-calendar-protocol";
import { authFetch } from "../auth/auth-fetch";

async function request<T>(init?: RequestInit): Promise<T> {
  const response = await authFetch("/api/integrations/google-calendar", {
    ...init,
    headers: { ...init?.headers },
  });
  const value = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? "Google Calendar request failed.");
  return value;
}

export async function fetchGoogleCalendarConnection(): Promise<GoogleCalendarConnection> {
  return (await request<{ connection: GoogleCalendarConnection }>()).connection;
}

export async function startGoogleCalendarConnection(): Promise<string> {
  return (await request<{ authorizationUrl: string }>({ method: "POST" })).authorizationUrl;
}

export async function disconnectGoogleCalendarConnection(): Promise<void> {
  await request({ method: "DELETE" });
}
