import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../../auth/owner-auth-service";
import { ChatDocumentError, DOCUMENT_CONTENT_TYPES, MAX_PDF_BYTES } from "../../../../../lib/chat-document";
import { ensureChatDocumentSchema } from "../../../../server/chat/chat-document-schema";
import { enqueueDocumentProcessingJob } from "../../../../server/chat/document-processing-job-store";
import { ensureProjectConversation } from "../../../../server/projects/project-service";

export const runtime = "nodejs";
export const maxDuration = 300;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createFinalizeHandler(dependencies = {
  authorizeOwnerSession,
  ensureChatDocumentSchema,
  enqueueDocumentProcessingJob,
}) {
  return async function POST(request: Request) {
    const owner = await dependencies.authorizeOwnerSession(request);
    if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (
      !body
      || typeof body.conversationId !== "string" || !ID_PATTERN.test(body.conversationId)
      || typeof body.documentId !== "string" || !ID_PATTERN.test(body.documentId)
      || typeof body.storageObjectId !== "string" || !UUID_PATTERN.test(body.storageObjectId)
      || typeof body.userMessageId !== "string" || !ID_PATTERN.test(body.userMessageId)
      || typeof body.jobId !== "string" || !ID_PATTERN.test(body.jobId)
      || (body.projectId !== undefined && (typeof body.projectId !== "string" || !ID_PATTERN.test(body.projectId)))
      || !DOCUMENT_CONTENT_TYPES.includes(body.contentType as never)
    ) return NextResponse.json({ error: "Invalid document metadata." }, { status: 400 });

    try {
      await dependencies.ensureChatDocumentSchema();
      if (typeof body.projectId === "string") await ensureProjectConversation(owner.id, body.projectId, body.conversationId);
      const job = await dependencies.enqueueDocumentProcessingJob({
        ownerId: owner.id,
        conversationId: body.conversationId,
        documentId: body.documentId,
        storageObjectId: body.storageObjectId,
        filename: typeof body.filename === "string" ? body.filename : "document",
        contentType: body.contentType as (typeof DOCUMENT_CONTENT_TYPES)[number],
        userMessageId: body.userMessageId,
        sourceJobId: body.jobId,
        chatProjectId: typeof body.projectId === "string" ? body.projectId : undefined,
      });
      if (job.document && job.document.size > MAX_PDF_BYTES) return NextResponse.json({ error: "Documents must be 25 MiB or smaller." }, { status: 413 });
      return NextResponse.json({
        processingJobId: job.jobId,
        documentId: job.documentId,
        status: job.status,
        progress: job.progress,
        ...(job.document ? { document: job.document } : {}),
      }, { status: job.status === "completed" ? 200 : 202 });
    } catch (error) {
      if (error instanceof ChatDocumentError && error.status === 413) return NextResponse.json({ error: "Documents must be 25 MiB or smaller." }, { status: 413 });
      if (error instanceof ChatDocumentError && error.status === 409) return NextResponse.json({ error: "The uploaded document object is invalid." }, { status: 409 });
      return NextResponse.json({ error: "The document could not be queued for background processing." }, { status: 503 });
    }
  };
}

export const POST = createFinalizeHandler();
