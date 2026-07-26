import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../../auth/owner-auth-service";
import { MAX_PDF_BYTES } from "../../../../../lib/chat-document";
import { createSignedDocumentUpload } from "../../../../server/chat/chat-document-store";

export function createUploadUrlHandler(deps = { authorizeOwnerSession, createSignedDocumentUpload }) { return async (request: Request) => {
  const auth = request.headers.get("authorization"); const owner = auth?.startsWith("Bearer ") ? await deps.authorizeOwnerSession(auth.slice(7)) : null;
  if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body.conversationId !== "string" || typeof body.pdfId !== "string" || typeof body.size !== "number" || body.size > MAX_PDF_BYTES || body.size < 1 || body.contentType !== "application/pdf") return NextResponse.json({ error: "Invalid PDF upload." }, { status: 400 });
  try { return NextResponse.json(await deps.createSignedDocumentUpload({ ownerId: owner.id, conversationId: body.conversationId, pdfId: body.pdfId })); } catch { return NextResponse.json({ error: "PDF storage is unavailable." }, { status: 503 }); }
}; }
export const POST = createUploadUrlHandler();
