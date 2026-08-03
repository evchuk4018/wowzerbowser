import { NextResponse } from "next/server";
import { CHAT_SEARCH_MAX_QUERY_LENGTH } from "../../../../lib/chat-search";
import { authorizeOwnerSession } from "../../../auth/owner-auth-service";
import { searchChatConversations } from "../../../server/chat/chat-history-store";

async function ownerFor(request: Request) {
  return authorizeOwnerSession(request);
}

export async function GET(request: Request) {
  const owner = await ownerFor(request);
  if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const query = new URL(request.url).searchParams.get("q") ?? "";
  if (query.length > CHAT_SEARCH_MAX_QUERY_LENGTH) {
    return NextResponse.json({ error: "Search query is too long." }, { status: 400 });
  }

  try {
    return NextResponse.json({ conversations: await searchChatConversations(owner.id, query) });
  } catch {
    return NextResponse.json({ error: "Chat search is unavailable." }, { status: 503 });
  }
}
