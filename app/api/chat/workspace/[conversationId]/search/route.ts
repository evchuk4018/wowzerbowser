import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../../../auth/owner-auth-service";
import { searchWorkspaceFiles, WorkspaceRequestError } from "../../../../../server/workspace/workspace-service";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ conversationId: string }> }) {
  const owner = await authorizeOwnerSession(request);
  if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    const body = await request.json() as { query?: unknown; path?: unknown; maxResults?: unknown };
    const { conversationId } = await context.params;
    if (typeof body.query !== "string") return NextResponse.json({ error: "query is required." }, { status: 400 });
    return NextResponse.json({ matches: await searchWorkspaceFiles(owner.id, conversationId, body.query, typeof body.path === "string" ? body.path : "", typeof body.maxResults === "number" ? body.maxResults : undefined) });
  } catch (error) {
    const status = error instanceof WorkspaceRequestError ? error.status : 503;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Workspace unavailable." }, { status });
  }
}
