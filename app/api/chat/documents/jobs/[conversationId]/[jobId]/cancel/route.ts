import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../../../../../auth/owner-auth-service";
import { cancelDocumentProcessingJob } from "../../../../../../../server/chat/document-processing-job-store";

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export async function POST(request: Request, context: { params: Promise<{ conversationId: string; jobId: string }> }) {
  const owner = await authorizeOwnerSession(request);
  if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { conversationId, jobId } = await context.params;
  if (!ID_PATTERN.test(conversationId) || !ID_PATTERN.test(jobId)) return NextResponse.json({ error: "Document job not found." }, { status: 404 });
  return (await cancelDocumentProcessingJob(owner.id, conversationId, jobId))
    ? NextResponse.json({ jobId, status: "cancelled" })
    : NextResponse.json({ error: "Document job not found or already finished." }, { status: 404 });
}
