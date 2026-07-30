import { NextResponse } from "next/server";
import { ownerFor } from "../../../../../server/connectors/connector-route-auth";
import { resolveConnectorApproval } from "../../../../../server/connectors/connector-approval-service";

export async function POST(request: Request, { params }: { params: Promise<{ approvalId: string }> }) {
  const owner = await ownerFor(request); if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const body = await request.json() as { decision?: unknown }; const decision = body.decision;
  if (decision !== "allow_once" && decision !== "always_allow" && decision !== "deny") return NextResponse.json({ error: "decision is invalid." }, { status: 400 });
  try { const resolved = await resolveConnectorApproval(owner.id, (await params).approvalId, decision); return resolved ? NextResponse.json({ resolved: true }) : NextResponse.json({ error: "Approval is no longer pending." }, { status: 409 }); }
  catch { return NextResponse.json({ error: "Approval could not be resolved." }, { status: 503 }); }
}
