import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../auth/owner-auth-service";
import { completeManagedConnection } from "../../../server/connectors/connector-service";
import { CONNECTOR_STATE_COOKIE, verifyConnectorOAuthState } from "../../../server/connectors/connector-oauth";
import { redactConnectorError } from "../../../server/connectors/connector-redaction";
import { integrationCallbackUrl } from "../../../server/integration-site-url";

function destination(connectorId: string | undefined, status: "connected" | "error", errorCode?: string) {
  const url = new URL(integrationCallbackUrl("/chat"));
  url.searchParams.set("connectorStatus", status);
  url.searchParams.set("settings", connectorId === "gmail" ? "tools" : "connectors");
  if (errorCode) url.searchParams.set("connectorError", errorCode);
  return url;
}

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
    await completeManagedConnection(verified.ownerId, verified.connectorId, code, state); response = NextResponse.redirect(destination(verified.connectorId, "connected"));
  } catch (error) {
    console.error("[connector-oauth] connection completion failed", {
      connectorId: verified?.connectorId ?? null,
      error: redactConnectorError(error),
    });
    response = NextResponse.redirect(destination(verified?.connectorId, "error", "completion_failed"));
  }
  response.cookies.set(CONNECTOR_STATE_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/api/connectors/callback", maxAge: 0 });
  return response;
}
