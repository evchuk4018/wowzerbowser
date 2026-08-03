import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../auth/owner-auth-service";
import { completeManagedConnection } from "../../../server/connectors/connector-service";
import { CONNECTOR_STATE_COOKIE, verifyConnectorOAuthState } from "../../../server/connectors/connector-oauth";

function destination(status: "connected" | "error") { const url = new URL("/", process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"); url.searchParams.set("connectors", status); url.searchParams.set("settings", "connectors"); return url; }

export async function GET(request: Request) {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  const cookie = request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${CONNECTOR_STATE_COOKIE}=`))?.slice(CONNECTOR_STATE_COOKIE.length + 1);
  const verified = verifyConnectorOAuthState(state, cookie ? decodeURIComponent(cookie) : undefined);
  const owner = await authorizeOwnerSession(request);
  let response: NextResponse;
  try {
    const code = url.searchParams.get("code"); if (!verified || !code || url.searchParams.has("error")) throw new Error("Invalid connector authorization response.");
    if (!owner || owner.id !== verified.ownerId) throw new Error("Invalid connector authorization response.");
    await completeManagedConnection(verified.ownerId, verified.connectorId, code, state); response = NextResponse.redirect(destination("connected"));
  } catch { response = NextResponse.redirect(destination("error")); }
  response.cookies.set(CONNECTOR_STATE_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/api/connectors/callback", maxAge: 0 });
  return response;
}
