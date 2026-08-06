import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../auth/owner-auth-service";
import { ChatProjectServiceError, createProject, listProjects } from "../../server/projects/project-service";

function serviceError(error: unknown, fallback: string) {
  return error instanceof ChatProjectServiceError
    ? NextResponse.json({ error: error.message }, { status: error.status })
    : NextResponse.json({ error: fallback }, { status: 503 });
}

export function createProjectCollectionHandlers(dependencies = { authorizeOwnerSession, listProjects, createProject }) {
  return {
    async GET(request: Request) {
      const owner = await dependencies.authorizeOwnerSession(request);
      if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
      try {
        return NextResponse.json({ projects: await dependencies.listProjects(owner.id) });
      } catch (error) {
        return serviceError(error, "Projects are unavailable.");
      }
    },
    async POST(request: Request) {
      const owner = await dependencies.authorizeOwnerSession(request);
      if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
      const body = await request.json().catch(() => null);
      try {
        const project = await dependencies.createProject(owner.id, body);
        return NextResponse.json({ project }, { status: 201 });
      } catch (error) {
        return serviceError(error, "The project could not be created.");
      }
    },
  };
}

const handlers = createProjectCollectionHandlers();
export const GET = handlers.GET;
export const POST = handlers.POST;
