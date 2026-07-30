import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";
export const GOOGLE_CALENDAR_STATE_COOKIE = "google_calendar_oauth_state";
const STATE_TTL_MS = 10 * 60_000;

function required(name: "GOOGLE_OAUTH_CLIENT_ID" | "GOOGLE_OAUTH_CLIENT_SECRET" | "GOOGLE_OAUTH_STATE_SECRET"): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

export function googleCalendarRedirectUri(): string {
  return new URL("/api/integrations/google-calendar/callback", process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000").toString();
}

function signature(payload: string): string {
  return createHmac("sha256", required("GOOGLE_OAUTH_STATE_SECRET")).update(payload).digest("base64url");
}

export function createGoogleCalendarState(ownerId: string): { state: string; cookieValue: string } {
  const payload = Buffer.from(JSON.stringify({
    ownerId,
    nonce: randomBytes(24).toString("base64url"),
    expiresAt: Date.now() + STATE_TTL_MS,
  })).toString("base64url");
  const state = `${payload}.${signature(payload)}`;
  return { state, cookieValue: state };
}

export function verifyGoogleCalendarState(state: string, cookieValue: string | undefined): string | null {
  if (!cookieValue || state !== cookieValue) return null;
  const [payload, provided, ...extra] = state.split(".");
  if (!payload || !provided || extra.length) return null;
  const expected = signature(payload);
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  try {
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { ownerId?: unknown; expiresAt?: unknown };
    return typeof value.ownerId === "string" && typeof value.expiresAt === "number" && value.expiresAt >= Date.now()
      ? value.ownerId
      : null;
  } catch {
    return null;
  }
}

export function googleCalendarAuthorizationUrl(state: string): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: required("GOOGLE_OAUTH_CLIENT_ID"),
    redirect_uri: googleCalendarRedirectUri(),
    response_type: "code",
    scope: GOOGLE_CALENDAR_SCOPE,
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
    state,
  }).toString();
  return url.toString();
}

async function tokenRequest(body: URLSearchParams): Promise<Record<string, unknown>> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const value = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof value.error_description === "string" ? value.error_description : "Google authorization failed.");
  return value;
}

export async function exchangeGoogleCalendarCode(code: string): Promise<{ refreshToken: string; scope: string }> {
  const value = await tokenRequest(new URLSearchParams({
    code,
    client_id: required("GOOGLE_OAUTH_CLIENT_ID"),
    client_secret: required("GOOGLE_OAUTH_CLIENT_SECRET"),
    redirect_uri: googleCalendarRedirectUri(),
    grant_type: "authorization_code",
  }));
  if (typeof value.refresh_token !== "string" || !value.refresh_token) {
    throw new Error("Google did not return offline access. Reconnect and approve calendar access.");
  }
  return {
    refreshToken: value.refresh_token,
    scope: typeof value.scope === "string" ? value.scope : GOOGLE_CALENDAR_SCOPE,
  };
}

export async function refreshGoogleAccessToken(refreshToken: string): Promise<string> {
  const value = await tokenRequest(new URLSearchParams({
    refresh_token: refreshToken,
    client_id: required("GOOGLE_OAUTH_CLIENT_ID"),
    client_secret: required("GOOGLE_OAUTH_CLIENT_SECRET"),
    grant_type: "refresh_token",
  }));
  if (typeof value.access_token !== "string" || !value.access_token) throw new Error("Google Calendar must be reconnected.");
  return value.access_token;
}
