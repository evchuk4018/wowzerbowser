import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../auth/owner-auth-service";
import { isChatProjectId } from "../../../../lib/chat-project-protocol";
import {
  ChatProjectServiceError,
  deleteProject,
  getProject,
  updateProject,
} from "../../../server/projects/project-service";

type Context = { params: Promise<{ projectId: string }> | { projectId: string } };

function serviceError(error: unknown, fallback: string) {
  return error instanceof ChatProjectServiceError
    ? NextResponse.json({ error: error.message }, { status: error.status })
    : NextResponse.json({ error: fallback }, { status: 503 });
}

export function createProjectHandler(dependencies = { authorizeOwnerSession, getProject, updateProject, deleteProject }) {
  return {
    async GET(request: Request, context: Context) {
      const owner = await dependencies.authorizeOwnerSession(request);
      if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
      const { projectId } = await context.params;
      if (!isChatProjectId(projectId)) return NextResponse.json({ error: "Project not found." }, { status: 404 });
      try {
        const project = await dependencies.getProject(owner.id, projectId);
        return project
          ? NextResponse.json({ project })
          : NextResponse.json({ error: "Project not found." }, { status: 404 });
      } catch (error) {
        return serviceError(error, "The project is unavailable.");
      }
    },
    async PATCH(request: Request, context: Context) {
      const owner = await dependencies.authorizeOwnerSession(request);
      if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
      const { projectId } = await context.params;
      if (!isChatProjectId(projectId)) return NextResponse.json({ error: "Project not found." }, { status: 404 });
      const body = await request.json().catch(() => null);
      try {
        return NextResponse.json({ project: await dependencies.updateProject(owner.id, projectId, body) });
      } catch (error) {
        return serviceError(error, "The project could not be updated.");
      }
    },
    async DELETE(request: Request, context: Context) {
      const owner = await dependencies.authorizeOwnerSession(request);
      if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
      const { projectId } = await context.params;
      if (!isChatProjectId(projectId)) return NextResponse.json({ error: "Project not found." }, { status: 404 });
      try {
        const deleted = await dependencies.deleteProject(owner.id, projectId);
        return deleted
          ? new NextResponse(null, { status: 204 })
          : NextResponse.json({ error: "Project not found." }, { status: 404 });
      } catch (error) {
        return serviceError(error, "The project could not be deleted.");
      }
    },
  };
}

const handlers = createProjectHandler();
export const GET = handlers.GET;
export const PATCH = handlers.PATCH;
export const DELETE = handlers.DELETE;
