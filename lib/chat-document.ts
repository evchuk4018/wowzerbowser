export const MAX_INLINE_PDF_TOKENS = 32_000;
export const MAX_INLINE_PDF_PAGES = 40;
export const MAX_PDF_PAGES_PER_READ = 20;
export const MAX_PDF_SEARCH_RESULTS = 10;
export const MAX_PDF_BYTES = 25 * 1024 * 1024;
export const DOCX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document" as const;
export const DOCUMENT_CONTENT_TYPES = ["application/pdf", DOCX_CONTENT_TYPE] as const;
export const CHAT_DOCUMENT_BUCKET = "chat-documents";

export type ChatDocumentImageAnalysis = { imageNumber: number; visibleText: string | null; mainVisuals: string | null };
export type ChatDocumentAttachment = {
  id: string;
  name: string;
  contentType: (typeof DOCUMENT_CONTENT_TYPES)[number];
  size: number;
  pageCount: number;
  tokenEstimate: number;
  hasImages: boolean;
  imageCount: number;
  analyzedImageCount: number;
  imageAnalyses: ChatDocumentImageAnalysis[];
};

export const PDF_PAGE_EXTRACTION_METHODS = ["native", "ocr", "blank"] as const;
export type PdfPageExtractionMethod = (typeof PDF_PAGE_EXTRACTION_METHODS)[number];

export type ChatDocumentPageFailure = {
  code: string;
  message: string;
  attempts?: number;
};

export type ChatDocumentPage = {
  pageNumber: number;
  text: string;
  extractionMethod: PdfPageExtractionMethod;
  failure?: ChatDocumentPageFailure;
};

export type PdfPageOcrDecision = {
  needsOcr: boolean;
  score: number;
  reasons: string[];
  nativeTextConfidence: number;
};

export type ChatDocumentPageCandidate = {
  pageNumber: number;
  text: string;
  textItemCount: number;
  imageObjectCount: number;
  pageWidth: number;
  pageHeight: number;
};

export type PdfExtractionQuality = {
  hasTextLayer: boolean;
  pagesWithText: number;
  pagesWithoutText: number;
  pagesWithImages: number;
  emptyPageCount: number;
  textCharacterCount: number;
  imageObjectCountAvailable: boolean;
};

export type NativePdfExtraction = {
  pageCount: number;
  textItemCount: number;
  imageObjectCount: number;
  pages: ChatDocumentPageCandidate[];
  pageOcrDecisions: PdfPageOcrDecision[];
  extractionQuality: PdfExtractionQuality;
};

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
    "This PDF is too large to inline. Use search_document and read_document_pages to inspect it; no partial text is included here.",
  ].join("\n");
}

export function documentContext(document: ChatDocumentAttachment, pages: readonly ChatDocumentPage[]): string {
  if (document.contentType === "application/pdf") return pdfContext(document, pages);
  const imageMetadata = `Embedded images: ${document.hasImages ? "yes" : "no"}; count=${document.imageCount}; analyzed=${document.analyzedImageCount}.`;
  if (document.tokenEstimate <= MAX_INLINE_PDF_TOKENS) {
    const analyses = document.imageAnalyses.map((image) => `[Embedded image ${image.imageNumber} analysis]\nVisible text: ${image.visibleText ?? "none"}\nMain visuals: ${image.mainVisuals ?? "none"}`);
    return [`[Attached DOCX: ${document.name} (${document.id})]`, imageMetadata, ...pages.map((page) => `[DOCX logical page ${page.pageNumber}]\n${page.text}`), ...analyses].join("\n\n");
  }
  return [`[Attached DOCX: id=${document.id}; filename=${document.name}; logical pages=${document.pageCount}; estimated tokens=${document.tokenEstimate}]`, imageMetadata, "This DOCX is too large to inline. Use search_document and read_document_pages to inspect it; no partial text is included here."].join("\n");
}

export class ChatDocumentError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) { super(message); }
}
