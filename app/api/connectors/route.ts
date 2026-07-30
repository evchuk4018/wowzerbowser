import { NextResponse } from "next/server";
import { ownerFor } from "../../server/connectors/connector-route-auth";
import { createRemoteMcpConnector, listConnectorCatalog } from "../../server/connectors/connector-service";

export async function GET(request: Request) {
  const owner = await ownerFor(request); if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try { return NextResponse.json({ connectors: await listConnectorCatalog(owner.id) }); }
  catch { return NextResponse.json({ error: "Connectors are unavailable." }, { status: 503 }); }
}

export async function POST(request: Request) {
  const owner = await ownerFor(request); if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    const body = await request.json() as Record<string, unknown>;
    if (typeof body.name !== "string" || typeof body.endpointUrl !== "string") return NextResponse.json({ error: "name and endpointUrl are required." }, { status: 400 });
    const connector = await createRemoteMcpConnector(owner.id, { name: body.name, endpointUrl: body.endpointUrl, description: typeof body.description === "string" ? body.description : undefined, token: typeof body.token === "string" && body.token ? body.token : undefined });
    return NextResponse.json({ connector }, { status: 201 });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "MCP server could not be added." }, { status: 400 }); }
}
