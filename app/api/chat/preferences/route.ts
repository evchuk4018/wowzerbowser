import { NextResponse } from "next/server";
import { parseChatModelPreference } from "../../../../lib/chat-model-preference";
import { authorizeOwnerSession } from "../../../auth/owner-auth-service";
import {
  listChatModelPreferences,
  saveChatModelPreference,
} from "../../../server/chat/chat-model-preference-store";

const unauthorized = () => NextResponse.json({ error: "Unauthorized." }, { status: 401 });

async function ownerFor(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  return authorizeOwnerSession(authorization.slice(7));
}

export async function GET(request: Request) {
  const owner = await ownerFor(request);
  if (!owner) return unauthorized();
  try {
    return NextResponse.json({ preferences: await listChatModelPreferences(owner.id) });
  } catch {
    return NextResponse.json({ error: "Chat preferences are unavailable." }, { status: 503 });
  }
}

export async function PUT(request: Request) {
  const owner = await ownerFor(request);
  if (!owner) return unauthorized();
  try {
    const body = await request.json() as { conversationId?: unknown; preference?: unknown };
    const preference = parseChatModelPreference(body.preference);
    if (typeof body.conversationId !== "string" || !body.conversationId.trim() || !preference) {
      return NextResponse.json({ error: "Invalid chat preference." }, { status: 400 });
    }
    await saveChatModelPreference(owner.id, body.conversationId, preference);
    return new NextResponse(null, { status: 204 });
  } catch {
    return NextResponse.json({ error: "Chat preferences are unavailable." }, { status: 503 });
  }
}
