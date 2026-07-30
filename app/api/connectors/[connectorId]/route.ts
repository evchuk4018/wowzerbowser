import { NextResponse } from "next/server";
import { ownerFor } from "../../../server/connectors/connector-route-auth";
import { listConnectorCatalog, removeRemoteMcpConnector } from "../../../server/connectors/connector-service";

export async function GET(request: Request, { params }: { params: Promise<{ connectorId: string }> }) {
  const owner = await ownerFor(request); if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { connectorId } = await params;
  try { const connector = (await listConnectorCatalog(owner.id)).find((item) => item.id === connectorId); return connector ? NextResponse.json({ connector }) : NextResponse.json({ error: "Connector not found." }, { status: 404 }); }
  catch { return NextResponse.json({ error: "Connector is unavailable." }, { status: 503 }); }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ connectorId: string }> }) {
  const owner = await ownerFor(request); if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { connectorId } = await params;
  try { await removeRemoteMcpConnector(owner.id, connectorId); return NextResponse.json({ removed: true }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Connector could not be removed." }, { status: 400 }); }
}
