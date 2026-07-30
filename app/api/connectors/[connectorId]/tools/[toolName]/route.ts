import { NextResponse } from "next/server";
import { ownerFor } from "../../../../../server/connectors/connector-route-auth";
import { updateConnectorTool } from "../../../../../server/connectors/connector-service";

export async function PATCH(request: Request, { params }: { params: Promise<{ connectorId: string; toolName: string }> }) {
  const owner = await ownerFor(request); if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { connectorId, toolName } = await params; const body = await request.json() as { enabled?: unknown; approvalMode?: unknown };
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") return NextResponse.json({ error: "enabled must be boolean." }, { status: 400 });
  if (body.approvalMode !== undefined && body.approvalMode !== "never" && body.approvalMode !== "always") return NextResponse.json({ error: "approvalMode is invalid." }, { status: 400 });
  try { await updateConnectorTool(owner.id, connectorId, decodeURIComponent(toolName), { ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}), ...(body.approvalMode === "never" || body.approvalMode === "always" ? { approvalMode: body.approvalMode } : {}) }); return NextResponse.json({ updated: true }); }
  catch { return NextResponse.json({ error: "Connector tool could not be updated." }, { status: 400 }); }
}
