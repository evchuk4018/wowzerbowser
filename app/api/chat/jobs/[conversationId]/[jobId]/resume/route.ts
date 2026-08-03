import { after } from "next/server";
import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../../../../auth/owner-auth-service";
import { runChatJob } from "../../../../../../server/chat/chat-job-runner";
import { logBackgroundTaskFailure } from "../../../../../../server/observability/background-error";

export async function POST(request: Request, context: { params: Promise<{ conversationId: string; jobId: string }> }) {
  const user = await authorizeOwnerSession(request);
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { conversationId, jobId } = await context.params;
  after(() => runChatJob(user.id, conversationId, jobId).catch((error) => {
    logBackgroundTaskFailure("chat-job-resume-failed", { ownerId: user.id, conversationId, jobId }, error);
  }));
  return NextResponse.json({ jobId, accepted: true }, { status: 202 });
}
