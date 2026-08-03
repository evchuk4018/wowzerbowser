import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../../../../../auth/owner-auth-service";
import { resumeDocumentProcessingJob } from "../../../../../../../server/chat/document-processing-job-store";

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export async function POST(request: Request, context: { params: Promise<{ conversationId: string; jobId: string }> }) {
  const owner = await authorizeOwnerSession(request);
  if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { conversationId, jobId } = await context.params;
  if (!ID_PATTERN.test(conversationId) || !ID_PATTERN.test(jobId)) return NextResponse.json({ error: "Document job is not resumable." }, { status: 409 });
  return (await resumeDocumentProcessingJob(owner.id, conversationId, jobId))
    ? NextResponse.json({ jobId, accepted: true }, { status: 202 })
    : NextResponse.json({ error: "Document job is not resumable." }, { status: 409 });
}
