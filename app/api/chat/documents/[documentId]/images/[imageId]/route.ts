import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../../../../auth/owner-auth-service";
import { ChatDocumentError } from "../../../../../../../lib/chat-document";
import { openAuthorizedDocumentImage } from "../../../../../../server/chat/chat-document-store";

export const runtime = "nodejs";

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function createDocumentImageReadHandler(dependencies = {
  authorizeOwnerSession,
  openAuthorizedDocumentImage,
}) {
  return async function GET(
    request: Request,
    context: { params: Promise<{ documentId: string; imageId: string }> | { documentId: string; imageId: string } },
  ) {
    const owner = await dependencies.authorizeOwnerSession(request);
    if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const { documentId, imageId } = await context.params;
    const conversationId = new URL(request.url).searchParams.get("conversationId")?.trim() ?? "";
    if (!ID_PATTERN.test(documentId) || !ID_PATTERN.test(imageId) || !ID_PATTERN.test(conversationId)) {
      return NextResponse.json({ error: "Document image not found." }, { status: 404 });
    }
    try {
      const opened = await dependencies.openAuthorizedDocumentImage(owner.id, conversationId, documentId, imageId);
      if (!opened) return NextResponse.json({ error: "Document image not found." }, { status: 404 });
      return new Response(opened.stream, {
        headers: {
          "cache-control": "private, no-store",
          "content-disposition": "inline",
          "content-length": String(opened.size),
          "content-type": opened.object.contentType,
          "x-content-type-options": "nosniff",
        },
      });
    } catch (error) {
      if (error instanceof ChatDocumentError && error.code === "document_storage_changed") {
        return NextResponse.json({ error: error.message }, { status: 409 });
      }
      return NextResponse.json({ error: "Document image not found." }, { status: 404 });
    }
  };
}

export const GET = createDocumentImageReadHandler();
