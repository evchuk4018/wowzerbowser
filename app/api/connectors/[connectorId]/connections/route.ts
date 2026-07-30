import { NextResponse } from "next/server";
import { ownerFor } from "../../../../server/connectors/connector-route-auth";
import { listConnections } from "../../../../server/connectors/connector-repository";
import { markDefaultConnectorConnection } from "../../../../server/connectors/connector-service";

export async function GET(request: Request, { params }: { params: Promise<{ connectorId: string }> }) {
  const owner = await ownerFor(request); if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { connectorId } = await params;
  try { const connections = await listConnections(owner.id, connectorId); return NextResponse.json({ connections: connections.map((row) => ({ id: row.id, connectorId: row.connector_id, accountLabel: row.account_label, accountEmail: row.account_email, status: row.status, isDefault: row.is_default, connectedAt: row.connected_at, updatedAt: row.updated_at })) }); }
  catch { return NextResponse.json({ error: "Connections are unavailable." }, { status: 503 }); }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ connectorId: string }> }) {
  const owner = await ownerFor(request); if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { connectorId } = await params; const body = await request.json() as { connectionId?: unknown };
  if (typeof body.connectionId !== "string") return NextResponse.json({ error: "connectionId is required." }, { status: 400 });
  try { await markDefaultConnectorConnection(owner.id, connectorId, body.connectionId); return NextResponse.json({ updated: true }); }
  catch { return NextResponse.json({ error: "Connection could not be selected." }, { status: 400 }); }
}
