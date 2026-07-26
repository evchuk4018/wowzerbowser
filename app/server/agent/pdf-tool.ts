import "server-only";
import type { ChatToolCall, ChatToolResult } from "../../../lib/chat-protocol";
import { MAX_PDF_PAGES_PER_READ, MAX_PDF_SEARCH_RESULTS } from "../../../lib/chat-document";
import { getAuthorizedDocument, getDocumentPages } from "../chat/chat-document-store";
import { PDF_TOOL_DEFINITIONS, READ_PDF_PAGES_TOOL_NAME, SEARCH_PDF_TOOL_NAME } from "./pdf-tool-manifest";

export function availablePdfTools(hasAuthorizedPdf: boolean) { return hasAuthorizedPdf ? PDF_TOOL_DEFINITIONS : []; }
const fail = (call: ChatToolCall, message: string): ChatToolResult => ({ id: call.id, name: call.name, ok: false, stdout: "", stderr: message });
export async function executePdfTool(call: ChatToolCall, context: { ownerId: string; conversationId: string; allowedPdfIds: ReadonlySet<string> }): Promise<ChatToolResult> {
  let args: Record<string, unknown>; try { args = JSON.parse(call.arguments); } catch { return fail(call, "Invalid document tool arguments."); }
  const pdfId = typeof args.documentId === "string" ? args.documentId : "";
  const authorized = context.allowedPdfIds.has(pdfId) ? await getAuthorizedDocument(context.ownerId, context.conversationId, pdfId) : null;
  if (!authorized) return fail(call, "Document is not authorized for this conversation.");
  if (call.name === SEARCH_PDF_TOOL_NAME) {
    const query = typeof args.query === "string" ? args.query.trim() : ""; if (!query) return fail(call, "query is required.");
    const pages = await getDocumentPages(context.ownerId, context.conversationId, pdfId);
    const needle = query.toLocaleLowerCase();
    const matches = pages.flatMap((page) => { const lower = page.text.toLocaleLowerCase(); const index = lower.indexOf(needle); if (index < 0) return []; const start = Math.max(0, index - 80); return [{ pageNumber: page.pageNumber, excerpt: page.text.slice(start, index + query.length + 80).replace(/\s+/g, " ").trim() }]; }).slice(0, MAX_PDF_SEARCH_RESULTS);
    return { id: call.id, name: call.name, ok: true, stdout: JSON.stringify({ results: matches }), stderr: "" };
  }
  if (call.name === READ_PDF_PAGES_TOOL_NAME) {
    const start = args.startPage, end = args.endPage;
    if (!Number.isInteger(start) || !Number.isInteger(end) || Number(start) < 1 || Number(end) < Number(start) || Number(end) - Number(start) + 1 > MAX_PDF_PAGES_PER_READ) return fail(call, `Use a valid, ordered range of at most ${MAX_PDF_PAGES_PER_READ} pages.`);
    const document = await getAuthorizedDocument(context.ownerId, context.conversationId, pdfId);
    if (!document || Number(end) > document.pageCount) return fail(call, "The requested page range is outside this document.");
    const pages = await getDocumentPages(context.ownerId, context.conversationId, pdfId, Number(start), Number(end));
    const label = authorized.contentType === "application/pdf" ? "PDF page" : "DOCX logical page";
    return { id: call.id, name: call.name, ok: true, stdout: pages.map((p) => `[${label} ${p.pageNumber}]\n${p.text}`).join("\n\n"), stderr: "" };
  }
  return fail(call, `Unknown tool: ${call.name}`);
}
