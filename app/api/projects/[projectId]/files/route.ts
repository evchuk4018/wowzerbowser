import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../../auth/owner-auth-service";
import { isChatProjectId } from "../../../../../lib/chat-project-protocol";
import { ChatProjectServiceError, listProjectFileMetadata } from "../../../../server/projects/project-service";

type Context = { params: Promise<{ projectId: string }> | { projectId: string } };

function serviceError(error: unknown, fallback: string) {
  return error instanceof ChatProjectServiceError
    ? NextResponse.json({ error: error.message }, { status: error.status })
    : NextResponse.json({ error: fallback }, { status: 503 });
}

export function createProjectFilesListHandler(dependencies = { authorizeOwnerSession, listProjectFileMetadata }) {
  return async function GET(request: Request, context: Context) {
    const owner = await dependencies.authorizeOwnerSession(request);
    if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const { projectId } = await context.params;
    if (!isChatProjectId(projectId)) return NextResponse.json({ error: "Project not found." }, { status: 404 });
    try {
      return NextResponse.json({ files: await dependencies.listProjectFileMetadata(owner.id, projectId) });
    } catch (error) {
      return serviceError(error, "Project files are unavailable.");
    }
  };
}

export const GET = createProjectFilesListHandler();
