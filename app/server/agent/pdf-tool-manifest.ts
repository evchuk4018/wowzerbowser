import type { DeepSeekToolDefinition } from "../../providers/deepseek/deepseek-adapter";
import { runtimeConfigSnapshot } from "../config/runtime-config-service";
import { MAX_PDF_PAGES_PER_READ, MAX_PDF_SEARCH_RESULTS } from "../../../lib/chat-document";
import { MAX_IMAGE_FOLLOWUP_QUESTION_LENGTH } from "../../../lib/chat-image";

export const SEARCH_PDF_TOOL_NAME = "search_document";
export const READ_PDF_PAGES_TOOL_NAME = "read_document_pages";
export const INSPECT_DOCUMENT_PAGE_TOOL_NAME = "inspect_document_page";

function configuredLimit(key: "pdfSearchMaxResults" | "pdfReadMaxPages", fallback: number, hardCap: number): number {
  const value = (runtimeConfigSnapshot() as unknown as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isSafeInteger(value)
    ? Math.max(1, Math.min(hardCap, value))
    : fallback;
}

export function configuredPdfSearchMaxResults(): number {
  return configuredLimit("pdfSearchMaxResults", MAX_PDF_SEARCH_RESULTS, MAX_PDF_SEARCH_RESULTS);
}

export function configuredPdfReadMaxPages(): number {
  return configuredLimit("pdfReadMaxPages", MAX_PDF_PAGES_PER_READ, MAX_PDF_PAGES_PER_READ);
}

export function pdfToolDefinitions(): DeepSeekToolDefinition[] {
  return [
    { type: "function", function: { name: SEARCH_PDF_TOOL_NAME, description: `Search the plain-text extraction of an authorized attached PDF or DOCX and return up to ${configuredPdfSearchMaxResults()} matching pages and excerpts.`, parameters: { type: "object", additionalProperties: false, required: ["documentId", "query"], properties: { documentId: { type: "string" }, query: { type: "string" } } } } },
    { type: "function", function: { name: READ_PDF_PAGES_TOOL_NAME, description: `Read Markdown from a one-based page range of at most ${configuredPdfReadMaxPages()} pages in an authorized PDF or DOCX. DOCX pages are logical pages, not rendered Word pages.`, parameters: { type: "object", additionalProperties: false, required: ["documentId", "startPage", "endPage"], properties: { documentId: { type: "string", description: "Authorized document id." }, startPage: { type: "integer", minimum: 1 }, endPage: { type: "integer", minimum: 1 } } } } },
    { type: "function", function: { name: INSPECT_DOCUMENT_PAGE_TOOL_NAME, description: "Render one authorized PDF page and ask a focused visual question when extracted Markdown and image descriptions are insufficient.", parameters: { type: "object", additionalProperties: false, required: ["documentId", "pageNumber", "question"], properties: { documentId: { type: "string" }, pageNumber: { type: "integer", minimum: 1 }, question: { type: "string", minLength: 1, maxLength: MAX_IMAGE_FOLLOWUP_QUESTION_LENGTH } } } } },
  ];
}

export const PDF_TOOL_DEFINITIONS = pdfToolDefinitions();
