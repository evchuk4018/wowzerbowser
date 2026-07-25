import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../../auth/owner-auth-service";
import {
  getChatConversation,
  updateChatActiveVersion,
  updateChatConversationTitle,
} from "../../../../server/chat/chat-history-store";

const idPattern = /^[a-zA-Z0-9_-]{1,128}$/;

async function ownerFor(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  return authorizeOwnerSession(authorization.slice(7));
}

export async function GET(request: Request, context: { params: Promise<{ conversationId: string }> }) {
  const owner = await ownerFor(request);
  if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { conversationId } = await context.params;
  if (!idPattern.test(conversationId)) return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
  try {
    const conversation = await getChatConversation(owner.id, conversationId);
    return conversation
      ? NextResponse.json({ conversation })
      : NextResponse.json({ error: "Conversation not found." }, { status: 404 });
  } catch {
    return NextResponse.json({ error: "Chat history is unavailable." }, { status: 503 });
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ conversationId: string }> }) {
  const owner = await ownerFor(request);
  if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { conversationId } = await context.params;
  if (!idPattern.test(conversationId)) return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
  try {
    const body = await request.json() as {
      title?: unknown;
      turnId?: unknown;
      versionId?: unknown;
    };
    if (body.title !== undefined) {
      if (typeof body.title !== "string" || !body.title.trim() || body.title.length > 160) {
        return NextResponse.json({ error: "Invalid conversation title." }, { status: 400 });
      }
      await updateChatConversationTitle(owner.id, conversationId, body.title);
    }
    if (body.turnId !== undefined || body.versionId !== undefined) {
      if (typeof body.turnId !== "string" || typeof body.versionId !== "string" || !idPattern.test(body.turnId) || !idPattern.test(body.versionId)) {
        return NextResponse.json({ error: "Invalid conversation version." }, { status: 400 });
      }
      await updateChatActiveVersion(owner.id, conversationId, body.turnId, body.versionId);
    }
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (error instanceof SyntaxError) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    return NextResponse.json({ error: "Chat history is unavailable." }, { status: 503 });
  }
}
