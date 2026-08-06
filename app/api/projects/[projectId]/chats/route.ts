import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../../auth/owner-auth-service";
import { isChatProjectId } from "../../../../../lib/chat-project-protocol";
import {
  ChatProjectServiceError,
  createProjectChat,
  listProjectChatsForOwner,
} from "../../../../server/projects/project-service";

type Context = { params: Promise<{ projectId: string }> | { projectId: string } };

function serviceError(error: unknown, fallback: string) {
  return error instanceof ChatProjectServiceError
    ? NextResponse.json({ error: error.message }, { status: error.status })
    : NextResponse.json({ error: fallback }, { status: 503 });
}

async function bodyOrUndefined(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function createProjectChatsHandler(dependencies = { authorizeOwnerSession, listProjectChatsForOwner, createProjectChat }) {
  return {
    async GET(request: Request, context: Context) {
      const owner = await dependencies.authorizeOwnerSession(request);
      if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
      const { projectId } = await context.params;
      if (!isChatProjectId(projectId)) return NextResponse.json({ error: "Project not found." }, { status: 404 });
      try {
        return NextResponse.json({ chats: await dependencies.listProjectChatsForOwner(owner.id, projectId) });
      } catch (error) {
        return serviceError(error, "Project chats are unavailable.");
      }
    },
    async POST(request: Request, context: Context) {
      const owner = await dependencies.authorizeOwnerSession(request);
      if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
      const { projectId } = await context.params;
      if (!isChatProjectId(projectId)) return NextResponse.json({ error: "Project not found." }, { status: 404 });
      const body = await bodyOrUndefined(request);
      try {
        return NextResponse.json({ chat: await dependencies.createProjectChat(owner.id, projectId, body) }, { status: 201 });
      } catch (error) {
        return serviceError(error, "The project chat could not be created.");
      }
    },
  };
}

const handlers = createProjectChatsHandler();
export const GET = handlers.GET;
export const POST = handlers.POST;
