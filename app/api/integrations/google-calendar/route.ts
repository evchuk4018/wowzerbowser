import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../auth/owner-auth-service";
import { disconnectGoogleCalendar, googleCalendarConnection } from "../../../server/calendar/google-calendar-service";
import {
  createGoogleCalendarState, GOOGLE_CALENDAR_STATE_COOKIE, googleCalendarAuthorizationUrl,
} from "../../../server/calendar/google-calendar-oauth";

async function owner(request: Request) {
  return authorizeOwnerSession(request);
}

export async function GET(request: Request) {
  const user = await owner(request);
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    return NextResponse.json({ connection: await googleCalendarConnection(user.id) });
  } catch {
    return NextResponse.json({ error: "Google Calendar connection status is unavailable." }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const user = await owner(request);
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    const { state, cookieValue } = createGoogleCalendarState(user.id);
    const response = NextResponse.json({ authorizationUrl: googleCalendarAuthorizationUrl(state) });
    response.cookies.set(GOOGLE_CALENDAR_STATE_COOKIE, cookieValue, {
      httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production",
      path: "/api/integrations/google-calendar/callback", maxAge: 600,
    });
    return response;
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Google Calendar connection could not start." }, { status: 503 });
  }
}

export async function DELETE(request: Request) {
  const user = await owner(request);
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    await disconnectGoogleCalendar(user.id);
    return NextResponse.json({ disconnected: true });
  } catch {
    return NextResponse.json({ error: "Google Calendar could not be disconnected." }, { status: 503 });
  }
}
