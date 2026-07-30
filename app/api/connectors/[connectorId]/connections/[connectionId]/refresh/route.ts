import { NextResponse } from "next/server";
import { ownerFor } from "../../../../../../server/connectors/connector-route-auth";
import { discoverConnectorTools } from "../../../../../../server/connectors/connector-service";

export async function POST(request: Request, { params }: { params: Promise<{ connectorId: string; connectionId: string }> }) {
  const owner = await ownerFor(request); if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { connectorId, connectionId } = await params;
  try { const tools = await discoverConnectorTools(owner.id, connectorId, connectionId); return NextResponse.json({ tools }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Tool discovery failed." }, { status: 503 }); }
}
