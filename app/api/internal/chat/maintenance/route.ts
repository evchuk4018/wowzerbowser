import { NextResponse } from "next/server";
import { configuredOwner } from "../../../../auth/owner-auth-service";
import { cleanupStaleEmptyChatConversations } from "../../../../server/chat/chat-conversation-service";

export const maxDuration = 60;

function maintenanceSecret(): string | null {
  return process.env.CHAT_MAINTENANCE_SECRET?.trim()
    || process.env.AUTOMATION_DISPATCH_SECRET?.trim()
    || null;
}

export async function POST(request: Request) {
  const secret = maintenanceSecret();
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  try {
    const owner = await configuredOwner();
    const deleted = await cleanupStaleEmptyChatConversations(owner.id);
    return NextResponse.json({ deleted });
  } catch {
    return NextResponse.json({ error: "Chat maintenance failed." }, { status: 503 });
  }
}
