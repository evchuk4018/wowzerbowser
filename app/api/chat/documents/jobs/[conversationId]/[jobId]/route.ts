import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../../../../auth/owner-auth-service";
import { getDocumentProcessingJob } from "../../../../../../server/chat/document-processing-job-store";

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export async function GET(request: Request, context: { params: Promise<{ conversationId: string; jobId: string }> }) {
  const owner = await authorizeOwnerSession(request);
  if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { conversationId, jobId } = await context.params;
  if (!ID_PATTERN.test(conversationId) || !ID_PATTERN.test(jobId)) return NextResponse.json({ error: "Document job not found." }, { status: 404 });
  const job = await getDocumentProcessingJob(owner.id, conversationId, jobId);
  return job ? NextResponse.json({
    jobId: job.jobId,
    documentId: job.documentId,
    status: job.status,
    error: job.error,
    progress: job.progress,
    ...(job.document ? { document: job.document } : {}),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  }) : NextResponse.json({ error: "Document job not found." }, { status: 404 });
}
