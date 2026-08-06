import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../../../auth/owner-auth-service";
import { deleteWorkspaceFile, writeWorkspaceFile, WorkspaceRequestError } from "../../../../../server/workspace/workspace-service";

export const runtime = "nodejs";

async function ownerOrUnauthorized(request: Request) {
  return authorizeOwnerSession(request);
}

export async function PUT(request: Request, context: { params: Promise<{ conversationId: string }> }) {
  const owner = await ownerOrUnauthorized(request);
  if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    const body = await request.json() as { path?: unknown; content?: unknown; expectedSha256?: unknown };
    const { conversationId } = await context.params;
    if (typeof body.path !== "string" || typeof body.content !== "string") return NextResponse.json({ error: "path and content are required." }, { status: 400 });
    return NextResponse.json(await writeWorkspaceFile(owner.id, conversationId, body.path, body.content, typeof body.expectedSha256 === "string" ? body.expectedSha256 : undefined));
  } catch (error) {
    const status = error instanceof WorkspaceRequestError ? error.status : 503;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Workspace unavailable." }, { status });
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ conversationId: string }> }) {
  const owner = await ownerOrUnauthorized(request);
  if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    const body = await request.json() as { path?: unknown };
    const { conversationId } = await context.params;
    if (typeof body.path !== "string") return NextResponse.json({ error: "path is required." }, { status: 400 });
    await deleteWorkspaceFile(owner.id, conversationId, body.path);
    return NextResponse.json({ deleted: true });
  } catch (error) {
    const status = error instanceof WorkspaceRequestError ? error.status : 503;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Workspace unavailable." }, { status });
  }
}
