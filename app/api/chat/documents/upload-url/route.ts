import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../../auth/owner-auth-service";
import { DOCUMENT_CONTENT_TYPES, MAX_PDF_BYTES } from "../../../../../lib/chat-document";
import { createSignedDocumentUpload } from "../../../../server/chat/chat-document-store";

export function createUploadUrlHandler(deps = { authorizeOwnerSession, createSignedDocumentUpload }) { return async (request: Request) => {
  const auth = request.headers.get("authorization"); const owner = auth?.startsWith("Bearer ") ? await deps.authorizeOwnerSession(auth.slice(7)) : null;
  if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body.conversationId !== "string" || typeof body.documentId !== "string" || typeof body.size !== "number" || body.size > MAX_PDF_BYTES || body.size < 1 || !DOCUMENT_CONTENT_TYPES.includes(body.contentType as never)) return NextResponse.json({ error: "Invalid document upload." }, { status: 400 });
  try { return NextResponse.json(await deps.createSignedDocumentUpload({ ownerId: owner.id, conversationId: body.conversationId, documentId: body.documentId, contentType: body.contentType as (typeof DOCUMENT_CONTENT_TYPES)[number] })); } catch { return NextResponse.json({ error: "Document storage is unavailable." }, { status: 503 }); }
}; }
export const POST = createUploadUrlHandler();
