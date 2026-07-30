import { NextResponse } from "next/server";
import { ownerFor } from "../../../../../server/connectors/connector-route-auth";
import { disconnectConnectorConnection } from "../../../../../server/connectors/connector-service";

export async function DELETE(request: Request, { params }: { params: Promise<{ connectorId: string; connectionId: string }> }) {
  const owner = await ownerFor(request); if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { connectorId, connectionId } = await params;
  try { await disconnectConnectorConnection(owner.id, connectorId, connectionId); return NextResponse.json({ disconnected: true }); }
  catch { return NextResponse.json({ error: "Connection could not be disconnected." }, { status: 400 }); }
}
