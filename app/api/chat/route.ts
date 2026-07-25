import { after } from "next/server";
import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../auth/owner-auth-service";
import { parseChatRequest, ChatRequestValidationError } from "../../../lib/chat-protocol";
import { assertDeepSeekConfigured, DeepSeekError } from "../../providers/deepseek/deepseek-adapter";
import { createOrGetChatJob } from "../../server/chat/chat-job-store";
import { runChatJob } from "../../server/chat/chat-job-runner";

export const maxDuration = 300;
const unauthorized = () => NextResponse.json({ error: "Unauthorized." }, { status: 401 });

export async function POST(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return unauthorized();
  if (Number(request.headers.get("content-length") ?? "0") > 1_250_000) return NextResponse.json({ error: "Request is too large." }, { status: 413 });
  const user = await authorizeOwnerSession(authorization.slice(7));
  if (!user) return unauthorized();
  try {
    const chatRequest = parseChatRequest(await request.json());
    if (!chatRequest.conversationId || !chatRequest.jobId || !chatRequest.idempotencyKey || !chatRequest.persistence) {
      return NextResponse.json({ error: "conversationId, jobId, idempotencyKey, and persistence are required." }, { status: 400 });
    }
    assertDeepSeekConfigured();
    const submission = await createOrGetChatJob(user.id, chatRequest);
    if (submission.status === "queued") after(() => runChatJob(user.id, chatRequest.conversationId!, submission.jobId));
    return NextResponse.json(submission, { status: submission.resumed ? 200 : 202 });
  } catch (error) {
    if (error instanceof ChatRequestValidationError || error instanceof SyntaxError) return NextResponse.json({ error: error.message }, { status: 400 });
    const status = error instanceof DeepSeekError ? error.status : 503;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Chat storage is unavailable." }, { status });
  }
}
