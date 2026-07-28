import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../auth/owner-auth-service";
import { buildChatBootstrap } from "../../../server/chat/chat-bootstrap-service";

const noStore = { "Cache-Control": "private, no-store" };

export async function GET(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401, headers: noStore });
  }

  const owner = await authorizeOwnerSession(authorization.slice(7));
  if (!owner) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401, headers: noStore });
  }

  const startedAt = performance.now();
  const requestedConversationId = new URL(request.url).searchParams.get("conversationId") ?? undefined;
  try {
    const payload = await buildChatBootstrap(owner, requestedConversationId);
    return NextResponse.json(payload, {
      headers: {
        ...noStore,
        "Server-Timing": `chat-bootstrap;dur=${Math.round(performance.now() - startedAt)}`,
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Chat bootstrap is unavailable." },
      {
        status: 503,
        headers: {
          ...noStore,
          "Server-Timing": `chat-bootstrap;dur=${Math.round(performance.now() - startedAt)}`,
        },
      },
    );
  }
}
