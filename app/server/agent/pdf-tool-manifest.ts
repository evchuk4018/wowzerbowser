import type { DeepSeekToolDefinition } from "../../providers/deepseek/deepseek-adapter";

export const SEARCH_PDF_TOOL_NAME = "search_pdf";
export const READ_PDF_PAGES_TOOL_NAME = "read_pdf_pages";
export const PDF_TOOL_DEFINITIONS: DeepSeekToolDefinition[] = [
  { type: "function", function: { name: SEARCH_PDF_TOOL_NAME, description: "Search an authorized attached PDF and return matching pages and excerpts.", parameters: { type: "object", additionalProperties: false, required: ["pdfId", "query"], properties: { pdfId: { type: "string" }, query: { type: "string" } } } } },
  { type: "function", function: { name: READ_PDF_PAGES_TOOL_NAME, description: "Read complete text from a one-based page range in an authorized PDF.", parameters: { type: "object", additionalProperties: false, required: ["pdfId", "startPage", "endPage"], properties: { pdfId: { type: "string" }, startPage: { type: "integer", minimum: 1 }, endPage: { type: "integer", minimum: 1 } } } } },
];
