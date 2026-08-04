import type { DeepSeekToolDefinition } from "../../providers/deepseek/deepseek-adapter";
import { MAX_IMAGE_FOLLOWUP_QUESTION_LENGTH } from "../../../lib/chat-image";

export const SEARCH_PDF_TOOL_NAME = "search_document";
export const READ_PDF_PAGES_TOOL_NAME = "read_document_pages";
export const INSPECT_DOCUMENT_PAGE_TOOL_NAME = "inspect_document_page";
export const PDF_TOOL_DEFINITIONS: DeepSeekToolDefinition[] = [
  { type: "function", function: { name: SEARCH_PDF_TOOL_NAME, description: "Search the plain-text extraction of an authorized attached PDF or DOCX and return matching pages and excerpts.", parameters: { type: "object", additionalProperties: false, required: ["documentId", "query"], properties: { documentId: { type: "string" }, query: { type: "string" } } } } },
  { type: "function", function: { name: READ_PDF_PAGES_TOOL_NAME, description: "Read Markdown from a one-based page range in an authorized PDF or DOCX. DOCX pages are logical pages, not rendered Word pages.", parameters: { type: "object", additionalProperties: false, required: ["documentId", "startPage", "endPage"], properties: { documentId: { type: "string" }, startPage: { type: "integer", minimum: 1 }, endPage: { type: "integer", minimum: 1 } } } } },
  { type: "function", function: { name: INSPECT_DOCUMENT_PAGE_TOOL_NAME, description: "Render one authorized PDF page and ask a focused visual question when extracted Markdown and image descriptions are insufficient.", parameters: { type: "object", additionalProperties: false, required: ["documentId", "pageNumber", "question"], properties: { documentId: { type: "string" }, pageNumber: { type: "integer", minimum: 1 }, question: { type: "string", minLength: 1, maxLength: MAX_IMAGE_FOLLOWUP_QUESTION_LENGTH } } } } },
];
