import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../../auth/owner-auth-service";
import { listWorkspaceFiles, WorkspaceRequestError } from "../../../../server/workspace/workspace-service";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ conversationId: string }> }) {
  const owner = await authorizeOwnerSession(request);
  if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    const { conversationId } = await context.params;
    const path = new URL(request.url).searchParams.get("path") ?? "";
    return NextResponse.json({ files: await listWorkspaceFiles(owner.id, conversationId, path) });
  } catch (error) {
    const status = error instanceof WorkspaceRequestError ? error.status : 503;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Workspace unavailable." }, { status });
  }
}
