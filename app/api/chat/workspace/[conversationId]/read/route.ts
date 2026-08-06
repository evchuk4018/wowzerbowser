import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../../../auth/owner-auth-service";
import { readWorkspaceFile, WorkspaceRequestError } from "../../../../../server/workspace/workspace-service";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ conversationId: string }> }) {
  const owner = await authorizeOwnerSession(request);
  if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    const body = await request.json() as { path?: unknown; startLine?: unknown; endLine?: unknown };
    const { conversationId } = await context.params;
    if (typeof body.path !== "string") return NextResponse.json({ error: "path is required." }, { status: 400 });
    return NextResponse.json(await readWorkspaceFile(owner.id, conversationId, body.path, typeof body.startLine === "number" ? body.startLine : undefined, typeof body.endLine === "number" ? body.endLine : undefined));
  } catch (error) {
    const status = error instanceof WorkspaceRequestError ? error.status : 503;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Workspace unavailable." }, { status });
  }
}
