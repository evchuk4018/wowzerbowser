import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../auth/owner-auth-service";
import { OpenRouterError } from "../../../providers/openrouter/openrouter-catalog-adapter";
import { generateAndPersistChatTitle } from "../../../server/chat/chat-title-service";

export async function POST(request: Request) {
  const owner = await authorizeOwnerSession(request);
  if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    const body = await request.json() as { firstTurn?: unknown; conversationId?: unknown };
    if (typeof body.firstTurn !== "string" || !body.firstTurn.trim() || body.firstTurn.length > 20_000 || typeof body.conversationId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(body.conversationId)) {
      return NextResponse.json({ error: "Invalid first turn." }, { status: 400 });
    }
    const title = await generateAndPersistChatTitle(owner.id, body.conversationId, body.firstTurn.trim());
    return NextResponse.json({ title });
  } catch (error) {
    const status = error instanceof OpenRouterError ? error.status : 503;
    return NextResponse.json({ error: "The chat could not be named." }, { status });
  }
}
