import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../auth/owner-auth-service";
import { parseChatRequest, ChatRequestValidationError } from "../../../lib/chat-protocol";
import { createChatEventStream } from "../../chat/chat-server-service";
import { assertDeepSeekConfigured, DeepSeekError } from "../../providers/deepseek/deepseek-adapter";

function unauthorizedResponse() {
  return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
}

export async function POST(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return unauthorizedResponse();

  const user = await authorizeOwnerSession(authorization.slice(7));
  if (!user) return unauthorizedResponse();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  let chatRequest;
  try {
    chatRequest = parseChatRequest(body);
    assertDeepSeekConfigured();
  } catch (error: unknown) {
    if (error instanceof ChatRequestValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    const status = error instanceof DeepSeekError ? error.status : 503;
    const message = error instanceof Error ? error.message : "DeepSeek is unavailable.";
    return NextResponse.json({ error: message }, { status });
  }

  return new Response(createChatEventStream(chatRequest, request.signal), {
    headers: {
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    },
  });
}
