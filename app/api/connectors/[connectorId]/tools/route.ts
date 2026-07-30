import { NextResponse } from "next/server";
import { ownerFor } from "../../../../server/connectors/connector-route-auth";
import { listConnectorTools } from "../../../../server/connectors/connector-service";

export async function GET(request: Request, { params }: { params: Promise<{ connectorId: string }> }) {
  const owner = await ownerFor(request); if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { connectorId } = await params;
  try { return NextResponse.json({ tools: await listConnectorTools(owner.id, connectorId) }); }
  catch { return NextResponse.json({ error: "Connector tools are unavailable." }, { status: 503 }); }
}
