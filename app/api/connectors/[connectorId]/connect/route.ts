import { NextResponse } from "next/server";
import { ownerFor } from "../../../../server/connectors/connector-route-auth";
import { createConnectorOAuthState, CONNECTOR_STATE_COOKIE } from "../../../../server/connectors/connector-oauth";
import { createManagedConnectionSession } from "../../../../server/connectors/connector-service";

export async function POST(request: Request, { params }: { params: Promise<{ connectorId: string }> }) {
  const owner = await ownerFor(request); if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { connectorId } = await params;
  try {
    const state = createConnectorOAuthState(owner.id, connectorId);
    const session = await createManagedConnectionSession(owner.id, connectorId, state.state);
    const response = NextResponse.json({ authorizationUrl: session.authorizationUrl });
    response.cookies.set(CONNECTOR_STATE_COOKIE, state.cookieValue, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/api/connectors/callback", maxAge: 600 });
    return response;
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Connector connection could not start." }, { status: 503 }); }
}
