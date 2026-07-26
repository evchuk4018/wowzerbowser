import "server-only";
import { DOCX_CONTENT_TYPE, estimatePdfTokens, MAX_PDF_BYTES, type ChatDocumentAttachment } from "../../../lib/chat-document";
import { parsePdfWithOpenRouter } from "../../providers/openrouter/openrouter-document-adapter";
import { documentStoragePath, registerDocument, uploadDocumentBytes } from "./chat-document-store";
import { parseDocx } from "./docx-parser";
import { analyzeDocumentImage } from "./chat-image-service";

export async function ingestPdf(input: { ownerId: string; conversationId: string; pdfId: string; filename: string; bytes: Uint8Array; userMessageId?: string; jobId?: string; alreadyUploaded?: boolean; signal?: AbortSignal }): Promise<ChatDocumentAttachment> {
  if (input.bytes.length > MAX_PDF_BYTES) throw new Error("PDFs must be 25 MiB or smaller.");
  if (input.bytes.length < 5 || new TextDecoder().decode(input.bytes.slice(0, 5)) !== "%PDF-") throw new Error("The uploaded file is not a valid PDF.");
  if (!input.alreadyUploaded) await uploadDocumentBytes(documentStoragePath(input.ownerId, input.conversationId, input.pdfId, "application/pdf"), input.bytes, "application/pdf");
  const pages = await parsePdfWithOpenRouter(input.bytes, input.filename, input.signal);
  const document: ChatDocumentAttachment = { id: input.pdfId, name: input.filename, contentType: "application/pdf", size: input.bytes.length, pageCount: pages.length, tokenEstimate: estimatePdfTokens(pages.map((p) => p.text).join("")), hasImages: false, imageCount: 0, analyzedImageCount: 0, imageAnalyses: [] };
  await registerDocument({ ownerId: input.ownerId, conversationId: input.conversationId, userMessageId: input.userMessageId ?? null, jobId: input.jobId ?? null, document, pages });
  return document;
}

export async function ingestDocx(input: { ownerId: string; conversationId: string; documentId: string; filename: string; bytes: Uint8Array; userMessageId?: string; jobId?: string; alreadyUploaded?: boolean; signal?: AbortSignal }): Promise<ChatDocumentAttachment> {
  if (input.bytes.length > MAX_PDF_BYTES) throw new Error("Documents must be 25 MiB or smaller.");
  const parsed = await parseDocx(input.bytes);
  if (!input.alreadyUploaded) await uploadDocumentBytes(documentStoragePath(input.ownerId, input.conversationId, input.documentId, DOCX_CONTENT_TYPE), input.bytes, DOCX_CONTENT_TYPE);
  const settled = await Promise.allSettled(parsed.images.map((image) => analyzeDocumentImage(image.bytes, image.contentType, input.signal).then((analysis) => ({ imageNumber: image.imageNumber, ...analysis }))));
  const imageAnalyses = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  const document: ChatDocumentAttachment = { id: input.documentId, name: input.filename, contentType: DOCX_CONTENT_TYPE, size: input.bytes.length, pageCount: parsed.pages.length, tokenEstimate: estimatePdfTokens(parsed.pages.map((page) => page.text).join("")), hasImages: parsed.imageCount > 0, imageCount: parsed.imageCount, analyzedImageCount: imageAnalyses.length, imageAnalyses };
  await registerDocument({ ownerId: input.ownerId, conversationId: input.conversationId, userMessageId: input.userMessageId ?? null, jobId: input.jobId ?? null, document, pages: parsed.pages });
  return document;
}
