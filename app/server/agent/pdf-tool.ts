import "server-only";
import type { ChatToolCall, ChatToolResult } from "../../../lib/chat-protocol";
import { documentPageMarkdown } from "../../../lib/chat-document";
import { getAuthorizedDocument, getDocumentPages } from "../chat/chat-document-store";
import { inspectDocumentPage, inspectDocumentPages } from "../chat/document-page-visual-service";
import { configuredPdfReadMaxPages, configuredPdfSearchMaxResults, configuredImageFollowupMaxQuestionCharacters, INSPECT_DOCUMENT_PAGE_TOOL_NAME, INSPECT_DOCUMENT_PAGES_TOOL_NAME, pdfToolDefinitions, READ_PDF_PAGES_TOOL_NAME, SEARCH_PDF_TOOL_NAME } from "./pdf-tool-manifest";

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const safeError = (error: unknown) => (error instanceof Error ? error.message : "Document inspection failed.").slice(0, 1_000);

export function availablePdfTools(hasAuthorizedDocument: boolean, hasAuthorizedPdf = hasAuthorizedDocument) {
  if (!hasAuthorizedDocument) return [];
  const definitions = pdfToolDefinitions();
  return hasAuthorizedPdf
    ? definitions
    : definitions.filter((tool) => ![INSPECT_DOCUMENT_PAGE_TOOL_NAME, INSPECT_DOCUMENT_PAGES_TOOL_NAME].includes(tool.function.name));
}

const fail = (call: ChatToolCall, message: string): ChatToolResult => ({ id: call.id, name: call.name, ok: false, stdout: "", stderr: message });
export async function executePdfTool(call: ChatToolCall, context: { ownerId: string; conversationId: string; allowedPdfIds: ReadonlySet<string>; jobId?: string; signal?: AbortSignal }): Promise<ChatToolResult> {
  let args: Record<string, unknown>; try { args = JSON.parse(call.arguments); } catch { return fail(call, "Invalid document tool arguments."); }
  const pdfId = typeof args.documentId === "string" ? args.documentId : "";
  if (!ID_PATTERN.test(pdfId)) return fail(call, "Document is not authorized for this conversation.");
  const authorized = context.allowedPdfIds.has(pdfId) ? await getAuthorizedDocument(context.ownerId, context.conversationId, pdfId) : null;
  if (!authorized) return fail(call, "Document is not authorized for this conversation.");
  if (call.name === INSPECT_DOCUMENT_PAGE_TOOL_NAME) {
    if (authorized.contentType !== "application/pdf") return fail(call, "Full-page visual inspection is available only for PDFs.");
    const pageNumber = args.pageNumber;
    const question = typeof args.question === "string" ? args.question.trim() : "";
    if (!Number.isSafeInteger(pageNumber) || Number(pageNumber) < 1 || Number(pageNumber) > authorized.pageCount) return fail(call, "The requested page is outside this document.");
    const maxQuestionCharacters = configuredImageFollowupMaxQuestionCharacters();
    if (!question || question.length > maxQuestionCharacters) return fail(call, `question is required and must be ${maxQuestionCharacters} characters or shorter.`);
    try {
      const result = await inspectDocumentPage({
        ownerId: context.ownerId,
        conversationId: context.conversationId,
        jobId: context.jobId,
        documentId: pdfId,
        pageNumber: Number(pageNumber),
        question,
        toolCallId: call.id,
        signal: context.signal,
      });
      return { id: call.id, name: call.name, ok: true, stdout: `[Untrusted PDF page ${result.pageNumber} visual inspection]\n${result.answer}`, stderr: "" };
    } catch (error) {
      return fail(call, safeError(error));
    }
  }
  if (call.name === INSPECT_DOCUMENT_PAGES_TOOL_NAME) {
    if (authorized.contentType !== "application/pdf") return fail(call, "Visual transcription is available only for PDFs.");
    const pageNumbers = args.pageNumbers;
    const question = typeof args.question === "string" ? args.question.trim() : "";
    if (!Array.isArray(pageNumbers) || pageNumbers.some((pageNumber) => !Number.isSafeInteger(pageNumber))) return fail(call, "pageNumbers must be an array of page numbers.");
    const maxQuestionCharacters = configuredImageFollowupMaxQuestionCharacters();
    if (!question || question.length > maxQuestionCharacters) return fail(call, `question is required and must be ${maxQuestionCharacters} characters or shorter.`);
    try {
      const result = await inspectDocumentPages({
        ownerId: context.ownerId,
        conversationId: context.conversationId,
        jobId: context.jobId,
        documentId: pdfId,
        pageNumbers: pageNumbers as number[],
        question,
        toolCallId: call.id,
        signal: context.signal,
      });
      return { id: call.id, name: call.name, ok: true, stdout: JSON.stringify({ documentId: pdfId, pages: result.pages }), stderr: "" };
    } catch (error) {
      return fail(call, safeError(error));
    }
  }
  if (call.name === SEARCH_PDF_TOOL_NAME) {
    const query = typeof args.query === "string" ? args.query.trim() : ""; if (!query) return fail(call, "query is required.");
    const pages = await getDocumentPages(context.ownerId, context.conversationId, pdfId);
    const needle = query.toLocaleLowerCase();
    const matches = pages.flatMap((page) => { const lower = page.text.toLocaleLowerCase(); const index = lower.indexOf(needle); if (index < 0) return []; const start = Math.max(0, index - 80); return [{ pageNumber: page.pageNumber, excerpt: page.text.slice(start, index + query.length + 80).replace(/\s+/g, " ").trim() }]; }).slice(0, configuredPdfSearchMaxResults());
    return { id: call.id, name: call.name, ok: true, stdout: JSON.stringify({ results: matches }), stderr: "" };
  }
  if (call.name === READ_PDF_PAGES_TOOL_NAME) {
    const start = args.startPage, end = args.endPage;
    const maxPages = configuredPdfReadMaxPages();
    if (!Number.isInteger(start) || !Number.isInteger(end) || Number(start) < 1 || Number(end) < Number(start) || Number(end) - Number(start) + 1 > maxPages) return fail(call, `Use a valid, ordered range of at most ${maxPages} pages.`);
    const document = await getAuthorizedDocument(context.ownerId, context.conversationId, pdfId);
    if (!document || Number(end) > document.pageCount) return fail(call, "The requested page range is outside this document.");
    const pages = await getDocumentPages(context.ownerId, context.conversationId, pdfId, Number(start), Number(end));
    const label = authorized.contentType === "application/pdf" ? "PDF page" : "DOCX logical page";
    return { id: call.id, name: call.name, ok: true, stdout: pages.map((p) => `[${label} ${p.pageNumber}]\n${documentPageMarkdown(p)}`).join("\n\n"), stderr: "" };
  }
  return fail(call, `Unknown tool: ${call.name}`);
}
