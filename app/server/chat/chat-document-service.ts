import "server-only";
import { estimatePdfTokens, MAX_PDF_BYTES, type ChatDocumentAttachment } from "../../../lib/chat-document";
import { parsePdfWithOpenRouter } from "../../providers/openrouter/openrouter-document-adapter";
import { documentStoragePath, registerDocument, uploadDocumentBytes } from "./chat-document-store";

export async function ingestPdf(input: { ownerId: string; conversationId: string; pdfId: string; filename: string; bytes: Uint8Array; userMessageId?: string; jobId?: string; alreadyUploaded?: boolean; signal?: AbortSignal }): Promise<ChatDocumentAttachment> {
  if (input.bytes.length > MAX_PDF_BYTES) throw new Error("PDFs must be 25 MiB or smaller.");
  if (input.bytes.length < 5 || new TextDecoder().decode(input.bytes.slice(0, 5)) !== "%PDF-") throw new Error("The uploaded file is not a valid PDF.");
  if (!input.alreadyUploaded) await uploadDocumentBytes(documentStoragePath(input.ownerId, input.conversationId, input.pdfId), input.bytes);
  const pages = await parsePdfWithOpenRouter(input.bytes, input.filename, input.signal);
  const document: ChatDocumentAttachment = { id: input.pdfId, name: input.filename, contentType: "application/pdf", size: input.bytes.length, pageCount: pages.length, tokenEstimate: estimatePdfTokens(pages.map((p) => p.text).join("")) };
  await registerDocument({ ownerId: input.ownerId, conversationId: input.conversationId, userMessageId: input.userMessageId ?? null, jobId: input.jobId ?? null, document, pages });
  return document;
}
