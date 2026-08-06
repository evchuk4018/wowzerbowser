import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../../../auth/owner-auth-service";
import { isChatProjectFileId, isChatProjectId } from "../../../../../../lib/chat-project-protocol";
import {
  ChatProjectServiceError,
  deleteProjectFile,
  readProjectFile,
} from "../../../../../server/projects/project-service";

export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string; fileId: string }> | { projectId: string; fileId: string } };

function serviceError(error: unknown, fallback: string) {
  return error instanceof ChatProjectServiceError
    ? NextResponse.json({ error: error.message }, { status: error.status })
    : NextResponse.json({ error: fallback }, { status: 503 });
}

function filenameHeader(name: string): string {
  return `attachment; filename="${name.replace(/["\\\r\n]/g, "_").slice(0, 160) || "file"}"`;
}

export function createProjectFileHandler(dependencies = { authorizeOwnerSession, readProjectFile, deleteProjectFile }) {
  return {
    async GET(request: Request, context: Context) {
      const owner = await dependencies.authorizeOwnerSession(request);
      if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
      const { projectId, fileId } = await context.params;
      if (!isChatProjectId(projectId) || !isChatProjectFileId(fileId)) return NextResponse.json({ error: "Project file not found." }, { status: 404 });
      try {
        const file = await dependencies.readProjectFile(owner.id, projectId, fileId);
        if (!file) return NextResponse.json({ error: "Project file not found." }, { status: 404 });
        return new Response(file.stream, {
          headers: {
            "cache-control": "private, no-store",
            "content-disposition": filenameHeader(file.metadata.name),
            "content-length": String(file.size),
            "content-type": file.metadata.contentType,
            "x-content-type-options": "nosniff",
          },
        });
      } catch (error) {
        return serviceError(error, "The project file could not be read.");
      }
    },
    async DELETE(request: Request, context: Context) {
      const owner = await dependencies.authorizeOwnerSession(request);
      if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
      const { projectId, fileId } = await context.params;
      if (!isChatProjectId(projectId) || !isChatProjectFileId(fileId)) return NextResponse.json({ error: "Project file not found." }, { status: 404 });
      try {
        const deleted = await dependencies.deleteProjectFile(owner.id, projectId, fileId);
        return deleted
          ? new NextResponse(null, { status: 204 })
          : NextResponse.json({ error: "Project file not found." }, { status: 404 });
      } catch (error) {
        return serviceError(error, "The project file could not be deleted.");
      }
    },
  };
}

const handlers = createProjectFileHandler();
export const GET = handlers.GET;
export const DELETE = handlers.DELETE;
