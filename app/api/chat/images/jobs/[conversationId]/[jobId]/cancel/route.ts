import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../../../../../auth/owner-auth-service";
import { isValidChatImageId } from "../../../../../../../../lib/chat-image";
import { cancelChatImageProcessingJob } from "../../../../../../../server/chat/chat-image-processing-job-store";

export async function POST(request: Request, context: { params: Promise<{ conversationId: string; jobId: string }> }) {
  const owner = await authorizeOwnerSession(request);
  if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { conversationId, jobId } = await context.params;
  if (!isValidChatImageId(conversationId) || !isValidChatImageId(jobId)) return NextResponse.json({ error: "Image job not found." }, { status: 404 });
  return (await cancelChatImageProcessingJob(owner.id, conversationId, jobId))
    ? NextResponse.json({ jobId, status: "cancelled" })
    : NextResponse.json({ error: "Image job not found or already finished." }, { status: 404 });
}
