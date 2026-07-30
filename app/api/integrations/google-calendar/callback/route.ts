import { NextResponse } from "next/server";
import { connectGoogleCalendar } from "../../../../server/calendar/google-calendar-service";
import {
  exchangeGoogleCalendarCode, GOOGLE_CALENDAR_STATE_COOKIE, verifyGoogleCalendarState,
} from "../../../../server/calendar/google-calendar-oauth";

function destination(status: "connected" | "error") {
  const url = new URL("/", process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000");
  url.searchParams.set("googleCalendar", status);
  return url;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  const cookie = request.headers.get("cookie")?.split(";").map((part) => part.trim())
    .find((part) => part.startsWith(`${GOOGLE_CALENDAR_STATE_COOKIE}=`))?.slice(GOOGLE_CALENDAR_STATE_COOKIE.length + 1);
  const ownerId = verifyGoogleCalendarState(state, cookie ? decodeURIComponent(cookie) : undefined);
  let response: NextResponse;
  try {
    const code = url.searchParams.get("code");
    if (!ownerId || !code || url.searchParams.has("error")) throw new Error("Invalid Google Calendar authorization response.");
    const token = await exchangeGoogleCalendarCode(code);
    await connectGoogleCalendar(ownerId, token.refreshToken, token.scope);
    response = NextResponse.redirect(destination("connected"));
  } catch {
    response = NextResponse.redirect(destination("error"));
  }
  response.cookies.set(GOOGLE_CALENDAR_STATE_COOKIE, "", {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production",
    path: "/api/integrations/google-calendar/callback", maxAge: 0,
  });
  return response;
}
