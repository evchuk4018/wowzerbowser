import "server-only";

import type { GoogleCalendarConnection } from "../../../lib/google-calendar-protocol";
import { decryptCalendarToken, encryptCalendarToken } from "./google-calendar-crypto";
import {
  deleteGoogleCalendarCredential,
  getGoogleCalendarCredential,
  saveGoogleCalendarCredential,
} from "./google-calendar-repository";
import { refreshGoogleAccessToken } from "./google-calendar-oauth";
import {
  googleCreateEvent, googleDeleteEvent, googleGetEvent, googleListEvents, googleUpdateEvent,
} from "./google-calendar-adapter";

export async function googleCalendarConnection(ownerId: string): Promise<GoogleCalendarConnection> {
  const value = await getGoogleCalendarCredential(ownerId);
  return value
    ? { connected: true, connectedAt: value.connectedAt, updatedAt: value.updatedAt }
    : { connected: false, connectedAt: null, updatedAt: null };
}

export async function connectGoogleCalendar(ownerId: string, refreshToken: string, scope: string): Promise<void> {
  await saveGoogleCalendarCredential(ownerId, encryptCalendarToken(refreshToken), scope);
}

export async function disconnectGoogleCalendar(ownerId: string): Promise<void> {
  await deleteGoogleCalendarCredential(ownerId);
}

async function accessToken(ownerId: string): Promise<string> {
  const credential = await getGoogleCalendarCredential(ownerId);
  if (!credential) throw new Error("Google Calendar is not connected. Connect it in Settings → Tools.");
  try {
    return await refreshGoogleAccessToken(decryptCalendarToken(credential));
  } catch {
    throw new Error("Google Calendar must be reconnected in Settings → Tools.");
  }
}

export async function listCalendarEvents(ownerId: string, input: Parameters<typeof googleListEvents>[1]) {
  return googleListEvents(await accessToken(ownerId), input);
}
export async function getCalendarEvent(ownerId: string, eventId: string) {
  return googleGetEvent(await accessToken(ownerId), eventId);
}
export async function createCalendarEvent(ownerId: string, event: Record<string, unknown>) {
  return googleCreateEvent(await accessToken(ownerId), event);
}
export async function updateCalendarEvent(ownerId: string, eventId: string, patch: Record<string, unknown>) {
  return googleUpdateEvent(await accessToken(ownerId), eventId, patch);
}
export async function deleteCalendarEvent(ownerId: string, eventId: string) {
  return googleDeleteEvent(await accessToken(ownerId), eventId);
}
