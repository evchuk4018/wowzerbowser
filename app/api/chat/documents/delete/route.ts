import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../../auth/owner-auth-service";
import { DOCUMENT_CONTENT_TYPES } from "../../../../../lib/chat-document";
import { deleteDocument } from "../../../../server/chat/chat-document-store";

export function createDeleteHandler(deps = { authorizeOwnerSession, deleteDocument }) {
  return async (request: Request) => {
    const auth = request.headers.get("authorization");
    const owner = auth?.startsWith("Bearer ")
      ? await deps.authorizeOwnerSession(auth.slice(7))
      : null;
    if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (
      !body
      || typeof body.conversationId !== "string"
      || typeof body.documentId !== "string"
      || !DOCUMENT_CONTENT_TYPES.includes(body.contentType as never)
    ) {
      return NextResponse.json({ error: "Invalid document metadata." }, { status: 400 });
    }

    try {
      await deps.deleteDocument({
        ownerId: owner.id,
        conversationId: body.conversationId,
        documentId: body.documentId,
        contentType: body.contentType as (typeof DOCUMENT_CONTENT_TYPES)[number],
      });
      return NextResponse.json({ deleted: true });
    } catch {
      return NextResponse.json({ error: "The document could not be deleted." }, { status: 502 });
    }
  };
}

export const DELETE = createDeleteHandler();
