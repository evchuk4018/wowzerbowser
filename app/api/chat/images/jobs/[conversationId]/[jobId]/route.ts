import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../../../../auth/owner-auth-service";
import { isValidChatImageId } from "../../../../../../../lib/chat-image";
import { getChatImageProcessingJob } from "../../../../../../server/chat/chat-image-processing-job-store";

export async function GET(request: Request, context: { params: Promise<{ conversationId: string; jobId: string }> }) {
  const owner = await authorizeOwnerSession(request);
  if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { conversationId, jobId } = await context.params;
  if (!isValidChatImageId(conversationId) || !isValidChatImageId(jobId)) return NextResponse.json({ error: "Image job not found." }, { status: 404 });
  const job = await getChatImageProcessingJob(owner.id, conversationId, jobId);
  return job ? NextResponse.json({
    jobId: job.jobId,
    imageId: job.imageId,
    status: job.status,
    error: job.error,
    progress: job.progress,
    ...(job.attachment ? { attachment: job.attachment } : {}),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  }) : NextResponse.json({ error: "Image job not found." }, { status: 404 });
}
