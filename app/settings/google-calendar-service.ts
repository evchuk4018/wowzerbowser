import type { GoogleCalendarConnection } from "../../lib/google-calendar-protocol";

async function request<T>(accessToken: string, init?: RequestInit): Promise<T> {
  const response = await fetch("/api/integrations/google-calendar", {
    ...init,
    headers: { authorization: `Bearer ${accessToken}`, ...init?.headers },
  });
  const value = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? "Google Calendar request failed.");
  return value;
}

export async function fetchGoogleCalendarConnection(accessToken: string): Promise<GoogleCalendarConnection> {
  return (await request<{ connection: GoogleCalendarConnection }>(accessToken)).connection;
}

export async function startGoogleCalendarConnection(accessToken: string): Promise<string> {
  return (await request<{ authorizationUrl: string }>(accessToken, { method: "POST" })).authorizationUrl;
}

export async function disconnectGoogleCalendarConnection(accessToken: string): Promise<void> {
  await request(accessToken, { method: "DELETE" });
}
