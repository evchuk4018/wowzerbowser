import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../../auth/owner-auth-service";
import { ChatDocumentError } from "../../../../../lib/chat-document";
import { openAuthorizedDocument } from "../../../../server/chat/chat-document-store";

export const runtime = "nodejs";

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function filenameHeader(name: string): string {
  const safe = name.normalize("NFKC").replace(/[\"\\\r\n]/g, "_").replace(/[^A-Za-z0-9._ -]/g, "").trim().slice(0, 160) || "document";
  return `attachment; filename="${safe}"`;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ documentId: string }> | { documentId: string } },
) {
  const owner = await authorizeOwnerSession(request);
  if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { documentId } = await context.params;
  const conversationId = new URL(request.url).searchParams.get("conversationId")?.trim() ?? "";
  if (!ID_PATTERN.test(documentId) || !ID_PATTERN.test(conversationId)) {
    return NextResponse.json({ error: "Document not found." }, { status: 404 });
  }
  try {
    const opened = await openAuthorizedDocument(owner.id, conversationId, documentId);
    if (!opened) return NextResponse.json({ error: "Document not found." }, { status: 404 });
    return new Response(opened.stream, {
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": filenameHeader(opened.object.originalFilename ?? "document"),
        "content-length": String(opened.size),
        "content-type": opened.object.contentType,
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof ChatDocumentError && error.code === "document_storage_changed") {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json({ error: "Document not found." }, { status: 404 });
  }
}
