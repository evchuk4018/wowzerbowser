import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../auth/owner-auth-service";
import { DeepSeekError } from "../../../providers/deepseek/deepseek-error";
import { generateDeepSeekTitle } from "../../../providers/deepseek/deepseek-title";
import { updateChatConversationTitle } from "../../../server/chat/chat-history-store";

export async function POST(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const owner = await authorizeOwnerSession(authorization.slice(7));
  if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    const body = await request.json() as { firstTurn?: unknown; conversationId?: unknown };
    if (typeof body.firstTurn !== "string" || !body.firstTurn.trim() || body.firstTurn.length > 20_000 || typeof body.conversationId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(body.conversationId)) {
      return NextResponse.json({ error: "Invalid first turn." }, { status: 400 });
    }
    const title = await generateDeepSeekTitle(body.firstTurn.trim());
    await updateChatConversationTitle(owner.id, body.conversationId, title);
    return NextResponse.json({ title });
  } catch (error) {
    const status = error instanceof DeepSeekError ? error.status : 503;
    return NextResponse.json({ error: "The chat could not be named." }, { status });
  }
}
