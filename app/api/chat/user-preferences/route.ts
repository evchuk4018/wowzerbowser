import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../auth/owner-auth-service";
import {
  parseChatUserPreferences,
  type ChatUserPreferences,
} from "../../../../lib/chat-user-preferences";
import {
  getChatUserPreferences,
  saveChatUserPreferences,
} from "../../../server/chat/chat-user-preferences-store";

async function ownerFor(request: Request) {
  return authorizeOwnerSession(request);
}

export async function GET(request: Request) {
  const owner = await ownerFor(request);
  if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    return NextResponse.json({ preferences: await getChatUserPreferences(owner.id) });
  } catch {
    return NextResponse.json({ error: "User preferences are unavailable." }, { status: 503 });
  }
}

export async function PUT(request: Request) {
  const owner = await ownerFor(request);
  if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    const preferences = parseChatUserPreferences(await request.json()) as ChatUserPreferences | null;
    if (!preferences) return NextResponse.json({ error: "Invalid user preferences." }, { status: 400 });
    await saveChatUserPreferences(owner.id, preferences);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (error instanceof SyntaxError) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    return NextResponse.json({ error: "User preferences are unavailable." }, { status: 503 });
  }
}
