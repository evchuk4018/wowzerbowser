import { after, NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../../auth/owner-auth-service";
import { DOCUMENT_CONTENT_TYPES } from "../../../../../lib/chat-document";
import { deleteDocument } from "../../../../server/chat/chat-document-store";
import { deleteDocumentProcessingJobsForDocument } from "../../../../server/chat/document-processing-job-store";
import { cleanupEmptyChatConversation } from "../../../../server/chat/chat-conversation-service";

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function scheduleCleanup(task: () => Promise<unknown>): void {
  try {
    after(() => task().catch(() => undefined));
  } catch {
    // Route unit tests do not provide a Next request context.
  }
}

export function createDeleteHandler(deps = { authorizeOwnerSession, deleteDocument, deleteDocumentProcessingJobsForDocument, cleanupEmptyChatConversation }) {
  return async (request: Request) => {
    const owner = await deps.authorizeOwnerSession(request);
    if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (
      !body
      || typeof body.conversationId !== "string"
      || typeof body.documentId !== "string"
      || !ID_PATTERN.test(body.conversationId)
      || !ID_PATTERN.test(body.documentId)
      || !DOCUMENT_CONTENT_TYPES.includes(body.contentType as never)
    ) {
      return NextResponse.json({ error: "Invalid document metadata." }, { status: 400 });
    }

    try {
      await deps.deleteDocumentProcessingJobsForDocument?.(owner.id, body.conversationId, body.documentId);
      await deps.deleteDocument({
        ownerId: owner.id,
        conversationId: body.conversationId,
        documentId: body.documentId,
        contentType: body.contentType as (typeof DOCUMENT_CONTENT_TYPES)[number],
      });
      if (deps.cleanupEmptyChatConversation) {
        scheduleCleanup(() => deps.cleanupEmptyChatConversation!(owner.id, body.conversationId as string));
      }
      return NextResponse.json({ deleted: true });
    } catch {
      return NextResponse.json({ error: "The document could not be deleted." }, { status: 502 });
    }
  };
}

export const DELETE = createDeleteHandler();
