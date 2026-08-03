import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../auth/owner-auth-service";
import { listChatConversations } from "../../../server/chat/chat-history-store";

async function ownerFor(request: Request) {
  return authorizeOwnerSession(request);
}

export async function GET(request: Request) {
  const owner = await ownerFor(request);
  if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    return NextResponse.json({ conversations: await listChatConversations(owner.id) });
  } catch {
    return NextResponse.json({ error: "Chat history is unavailable." }, { status: 503 });
  }
}
