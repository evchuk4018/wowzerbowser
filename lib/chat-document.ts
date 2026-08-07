export const MAX_INLINE_PDF_TOKENS = 32_000;
export const MAX_INLINE_PDF_PAGES = 40;
export const MAX_PDF_PAGES_PER_READ = 20;
export const MAX_PDF_SEARCH_RESULTS = 10;
export const MAX_PDF_BYTES = 25 * 1024 * 1024;
export const MAX_DOCUMENT_IMAGES = 32;
export const MAX_DOCUMENT_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_DOCUMENT_IMAGE_TOTAL_BYTES = 64 * 1024 * 1024;
export const DOCX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document" as const;
export const DOCUMENT_CONTENT_TYPES = ["application/pdf", DOCX_CONTENT_TYPE] as const;
export const CHAT_DOCUMENT_BUCKET = "chat-documents";

export type DocumentContextLimits = {
  maxInlineTokens?: number;
  maxInlinePages?: number;
};

export type ChatDocumentProviderMetadata = Record<string, unknown>;
export type ChatDocumentImage = {
  imageId: string;
  pageNumber: number;
  storageObjectId?: string | null;
  storagePath?: string | null;
  contentType?: string | null;
  providerMetadata?: ChatDocumentProviderMetadata;
};

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
  providerMetadata?: ChatDocumentProviderMetadata;
  images?: ChatDocumentImage[];
  projectId?: string;
  revisionId?: string;
  parentRevisionId?: string | null;
  origin?: "generated" | "uploaded";
  editable?: boolean;
  sourceCompleteness?: "complete" | "entrypoint-only";
};

export const PDF_PAGE_EXTRACTION_METHODS = ["native", "ocr", "opendataloader", "blank"] as const;
export type PdfPageExtractionMethod = (typeof PDF_PAGE_EXTRACTION_METHODS)[number];

export type ChatDocumentPageFailure = {
  code: string;
  message: string;
  attempts?: number;
};

export type ChatDocumentPage = {
  pageNumber: number;
  text: string;
  /** Markdown is preferred for model context; text remains the search representation. */
  markdown?: string | null;
  providerMetadata?: ChatDocumentProviderMetadata;
  images?: ChatDocumentImage[];
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

export function documentPageMarkdown(page: Pick<ChatDocumentPage, "text" | "markdown">): string {
  return page.markdown?.trim() ? page.markdown : page.text;
}

export function shouldInlineDocument(
  document: Pick<ChatDocumentAttachment, "pageCount" | "tokenEstimate">,
  limits: DocumentContextLimits = {},
): boolean {
  const maxPages = Math.min(limits.maxInlinePages ?? MAX_INLINE_PDF_PAGES, 200);
  const maxTokens = Math.min(limits.maxInlineTokens ?? MAX_INLINE_PDF_TOKENS, 100_000);
  return document.pageCount <= maxPages && document.tokenEstimate <= maxTokens;
}

/** Cache inline-page reads for the lifetime of one request. Large documents never invoke the loader. */
export function createInlineDocumentPageLoader<T>(
  load: (document: ChatDocumentAttachment) => Promise<readonly T[]>,
  limits: DocumentContextLimits = {},
): (document: ChatDocumentAttachment) => Promise<readonly T[]> {
  const pagesByDocument = new Map<string, Promise<readonly T[]>>();
  return (document) => {
    if (!shouldInlineDocument(document, limits)) return Promise.resolve([]);
    const cached = pagesByDocument.get(document.id);
    if (cached) return cached;
    const pages = load(document);
    pagesByDocument.set(document.id, pages);
    return pages;
  };
}

export function pdfContext(document: ChatDocumentAttachment, pages: readonly ChatDocumentPage[], limits: DocumentContextLimits = {}): string {
  if (shouldInlineDocument(document, limits)) {
    return [`[Attached PDF: ${document.name} (${document.id})]`, ...pages.map((page) =>
      `[PDF page ${page.pageNumber}]\n${documentPageMarkdown(page)}`),].join("\n\n");
  }
  return [
    `[Attached PDF: id=${document.id}; filename=${document.name}; pages=${document.pageCount}; estimated tokens=${document.tokenEstimate}]`,
    "This PDF is too large to inline. Use search_document and read_document_pages to inspect it; no partial text is included here.",
  ].join("\n");
}

export function documentContext(document: ChatDocumentAttachment, pages: readonly ChatDocumentPage[], limits: DocumentContextLimits = {}): string {
  if (document.contentType === "application/pdf") return pdfContext(document, pages, limits);
  const imageMetadata = `Embedded images: ${document.hasImages ? "yes" : "no"}; count=${document.imageCount}; analyzed=${document.analyzedImageCount}.`;
  if (shouldInlineDocument(document, limits)) {
    const analyses = document.imageAnalyses.map((image) => `[Embedded image ${image.imageNumber} analysis]\nVisible text: ${image.visibleText ?? "none"}\nMain visuals: ${image.mainVisuals ?? "none"}`);
    return [`[Attached DOCX: ${document.name} (${document.id})]`, imageMetadata, ...pages.map((page) => `[DOCX logical page ${page.pageNumber}]\n${page.text}`), ...analyses].join("\n\n");
  }
  return [`[Attached DOCX: id=${document.id}; filename=${document.name}; logical pages=${document.pageCount}; estimated tokens=${document.tokenEstimate}]`, imageMetadata, "This DOCX is too large to inline. Use search_document and read_document_pages to inspect it; no partial text is included here."].join("\n");
}

export class ChatDocumentError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) { super(message); }
}
