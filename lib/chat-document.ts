export const MAX_INLINE_PDF_TOKENS = 32_000;
export const MAX_INLINE_PDF_PAGES = 40;
export const MAX_PDF_PAGES_PER_READ = 20;
export const MAX_PDF_SEARCH_RESULTS = 10;
export const MAX_PDF_BYTES = 25 * 1024 * 1024;
export const CHAT_DOCUMENT_BUCKET = "chat-documents";

export type ChatDocumentAttachment = {
  id: string;
  name: string;
  contentType: "application/pdf";
  size: number;
  pageCount: number;
  tokenEstimate: number;
};

export type ChatDocumentPage = { pageNumber: number; text: string };

export function estimatePdfTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function pdfContext(document: ChatDocumentAttachment, pages: readonly ChatDocumentPage[]): string {
  if (document.pageCount <= MAX_INLINE_PDF_PAGES && document.tokenEstimate <= MAX_INLINE_PDF_TOKENS) {
    return [`[Attached PDF: ${document.name} (${document.id})]`, ...pages.map((page) =>
      `[PDF page ${page.pageNumber}]\n${page.text}`),].join("\n\n");
  }
  return [
    `[Attached PDF: id=${document.id}; filename=${document.name}; pages=${document.pageCount}; estimated tokens=${document.tokenEstimate}]`,
    "This PDF is too large to inline. Use search_pdf and read_pdf_pages to inspect it; no partial text is included here.",
  ].join("\n");
}

export class ChatDocumentError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) { super(message); }
}
