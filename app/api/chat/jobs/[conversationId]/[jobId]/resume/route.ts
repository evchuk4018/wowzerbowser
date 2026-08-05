import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../../../../auth/owner-auth-service";
import { getChatJob, resumeChatJobAfterApproval } from "../../../../../../server/chat/chat-job-store";

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export async function POST(request: Request, context: { params: Promise<{ conversationId: string; jobId: string }> }) {
  const user = await authorizeOwnerSession(request);
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { conversationId, jobId } = await context.params;
  if (!ID_PATTERN.test(conversationId) || !ID_PATTERN.test(jobId)) return NextResponse.json({ error: "Job not found." }, { status: 404 });
  const job = await getChatJob(user.id, conversationId, jobId, 0);
  if (job?.status === "awaiting_approval") await resumeChatJobAfterApproval(user.id, conversationId, jobId);
  return job
    ? NextResponse.json({ jobId, accepted: true }, { status: 202 })
    : NextResponse.json({ error: "Job not found." }, { status: 404 });
}
