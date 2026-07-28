import "server-only";

import type { ChatToolCall, ChatToolResult } from "../../../lib/chat-protocol";
import { getAuthorizedDocument, downloadAuthorizedDocumentBytes } from "../chat/chat-document-store";
import { inspectPdfEditability } from "../documents/pdf-edit-inspector";
import { editSourceBackedDocument } from "../documents/source-document-editor";
import { editPdfOperations, type PdfOperation } from "../documents/pdf-operation-editor";
import { compareDocumentRevisions } from "../documents/document-revision-compare";
import type { ModalPythonExecutor } from "../modal/modal-python-executor";
import { COMPARE_DOCUMENT_REVISIONS_TOOL_NAME, EDIT_PDF_TOOL_NAME, EDIT_SOURCE_BACKED_DOCUMENT_TOOL_NAME, INSPECT_PDF_EDITABILITY_TOOL_NAME } from "./pdf-edit-tool-manifest";

export { availablePdfEditTools } from "./pdf-edit-tool-manifest";
const fail = (call: ChatToolCall, message: string): ChatToolResult => ({ id: call.id, name: call.name, ok: false, stdout: "", stderr: message });
const safeError = (message: string) => message.replace(/(?:\/workspace\/|documents\/)[A-Za-z0-9_./ -]+/g, "the document workspace").slice(0, 1_000);
const isId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(value);
function parsePatches(value: unknown): Parameters<typeof editSourceBackedDocument>[0]["patches"] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) throw new Error("patches must contain between 1 and 20 entries.");
  return value.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error(`patches[${index}] is invalid.`);
    const patch = candidate as Record<string, unknown>;
    if (patch.type === "replace_text") {
      if (typeof patch.path !== "string" || typeof patch.oldText !== "string" || typeof patch.newText !== "string" || !Number.isSafeInteger(patch.expectedOccurrences) || Number(patch.expectedOccurrences) < 0) throw new Error(`patches[${index}] replacement is invalid.`);
      return { type: "replace_text", path: patch.path, oldText: patch.oldText, newText: patch.newText, expectedOccurrences: Number(patch.expectedOccurrences) };
    }
    if (patch.type === "unified_diff") {
      if (typeof patch.path !== "string" || typeof patch.patch !== "string") throw new Error(`patches[${index}] diff is invalid.`);
      return { type: "unified_diff", path: patch.path, patch: patch.patch };
    }
    throw new Error(`patches[${index}].type is unsupported.`);
  });
}

function parseArguments(call: ChatToolCall): Record<string, unknown> {
  let value: unknown; try { value = JSON.parse(call.arguments); } catch { throw new Error("Invalid PDF edit tool arguments."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("PDF edit tool arguments must be an object.");
  return value as Record<string, unknown>;
}

function parseOperations(value: unknown): PdfOperation[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 30) throw new Error("operations must contain between 1 and 30 entries.");
  return value.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) || typeof (candidate as { type?: unknown }).type !== "string") throw new Error(`operations[${index}] is invalid.`);
    const operation = candidate as Record<string, unknown>; const type = operation.type;
    const pages = (value: unknown, name: string) => { if (!Array.isArray(value) || value.some((page) => !Number.isInteger(page) || Number(page) < 1)) throw new Error(`${name} is invalid.`); return value as number[]; };
    if (type === "delete_pages") return { type, pages: pages(operation.pages, `operations[${index}].pages`) };
    if (type === "reorder_pages") return { type, order: pages(operation.order, `operations[${index}].order`) };
    if (type === "rotate_pages") { const degrees = operation.degrees; if (degrees !== 90 && degrees !== 180 && degrees !== 270) throw new Error("degrees must be 90, 180, or 270."); return { type, pages: pages(operation.pages, "pages"), degrees } as PdfOperation; }
    if (type === "insert_blank_page") return { type, afterPage: Number(operation.afterPage), ...(operation.width === undefined ? {} : { width: Number(operation.width) }), ...(operation.height === undefined ? {} : { height: Number(operation.height) }) } as PdfOperation;
    if (type === "merge_document") return { type, sourceDocumentId: String(operation.sourceDocumentId), afterPage: Number(operation.afterPage) };
    if (type === "redact_text") return { type, query: String(operation.query), ...(operation.pages === undefined ? {} : { pages: pages(operation.pages, "pages") }), ...(operation.expectedOccurrences === undefined ? {} : { expectedOccurrences: Number(operation.expectedOccurrences) }) };
    if (type === "replace_text") return { type, query: String(operation.query), replacement: String(operation.replacement), ...(operation.pages === undefined ? {} : { pages: pages(operation.pages, "pages") }), expectedOccurrences: Number(operation.expectedOccurrences), ...(operation.fontSize === undefined ? {} : { fontSize: Number(operation.fontSize) }) };
    if (type === "add_text") return { type, page: Number(operation.page), x: Number(operation.x), y: Number(operation.y), width: Number(operation.width), height: Number(operation.height), text: String(operation.text), fontSize: Number(operation.fontSize), ...(operation.align === undefined ? {} : { align: operation.align as "left" | "center" | "right" }) };
    if (type === "add_image") return { type, page: Number(operation.page), imageId: String(operation.imageId), x: Number(operation.x), y: Number(operation.y), width: Number(operation.width), height: Number(operation.height) };
    if (type === "watermark") return { type, text: String(operation.text), opacity: Number(operation.opacity), ...(operation.pages === undefined ? {} : { pages: pages(operation.pages, "pages") }) };
    if (type === "set_form_field") {
      if (typeof operation.fieldName !== "string" || !operation.fieldName.trim() || operation.fieldName.length > 512 || typeof operation.value !== "string" || operation.value.length > 16_384) throw new Error(`operations[${index}] form field is invalid.`);
      return { type, fieldName: operation.fieldName, value: operation.value };
    }
    throw new Error(`operations[${index}].type is unsupported.`);
  }) as PdfOperation[];
}

export async function executePdfEditTool(call: ChatToolCall, context: { ownerId: string; conversationId: string; allowedPdfIds: ReadonlySet<string>; allowedImageIds?: ReadonlySet<string>; allowedProjectIds?: ReadonlySet<string>; executor?: ModalPythonExecutor; jobId?: string | null }): Promise<ChatToolResult> {
  try {
    const args = parseArguments(call); const documentId = args.documentId;
    if (call.name !== COMPARE_DOCUMENT_REVISIONS_TOOL_NAME && (!isId(documentId) || !context.allowedPdfIds.has(documentId))) return fail(call, "Document is not authorized for this conversation.");
    if (call.name === INSPECT_PDF_EDITABILITY_TOOL_NAME) {
      const bytes = await downloadAuthorizedDocumentBytes(context.ownerId, context.conversationId, documentId as string); if (!bytes) return fail(call, "The PDF bytes are unavailable.");
      const result = await inspectPdfEditability({ ownerId: context.ownerId, conversationId: context.conversationId, documentId: documentId as string, bytes, pages: Array.isArray(args.pages) ? args.pages as number[] : undefined });
      return { id: call.id, name: call.name, ok: true, stdout: "", stderr: "", documentEdit: result };
    }
    if (call.name === EDIT_SOURCE_BACKED_DOCUMENT_TOOL_NAME) {
      const document = await getAuthorizedDocument(context.ownerId, context.conversationId, documentId as string); if (!document?.projectId || !document.revisionId || document.revisionId !== args.baseRevisionId || document.origin !== "generated") return fail(call, "The source-backed base revision is not authorized.");
      if (!context.executor) return fail(call, "PDF editing is not configured.");
      const patches = parsePatches(args.patches);
      const finalized = await editSourceBackedDocument({ ownerId: context.ownerId, conversationId: context.conversationId, documentId: document.id, projectId: document.projectId, baseRevisionId: String(args.baseRevisionId), patches, outputFilename: typeof args.outputFilename === "string" ? args.outputFilename : undefined, executor: context.executor, jobId: context.jobId });
      return { id: call.id, name: call.name, ok: true, stdout: "", stderr: "", documentEdit: finalized.result, artifacts: [finalized.artifact] };
    }
    if (call.name === EDIT_PDF_TOOL_NAME) {
      if (!context.executor) return fail(call, "PDF editing is not configured.");
      const operations = parseOperations(args.operations);
      for (const operation of operations) {
        if (operation.type === "merge_document" && !context.allowedPdfIds.has(operation.sourceDocumentId)) return fail(call, "The merged document is not authorized for this conversation.");
        if (operation.type === "add_image" && !context.allowedImageIds?.has(operation.imageId)) return fail(call, "The referenced image is not authorized for this conversation.");
      }
      const finalized = await editPdfOperations({ ownerId: context.ownerId, conversationId: context.conversationId, documentId: documentId as string, operations, outputFilename: typeof args.outputFilename === "string" ? args.outputFilename : undefined, executor: context.executor, jobId: context.jobId });
      return { id: call.id, name: call.name, ok: true, stdout: "", stderr: "", documentEdit: finalized.result, artifacts: [finalized.artifact] };
    }
    if (call.name === COMPARE_DOCUMENT_REVISIONS_TOOL_NAME) {
      const projectId = String(args.projectId); if (!isId(projectId) || !context.allowedProjectIds?.has(projectId) || !isId(args.leftRevisionId) || !isId(args.rightRevisionId)) return fail(call, "Revision comparison is not authorized.");
      const result = await compareDocumentRevisions({ ownerId: context.ownerId, conversationId: context.conversationId, projectId, leftRevisionId: String(args.leftRevisionId), rightRevisionId: String(args.rightRevisionId) });
      return { id: call.id, name: call.name, ok: true, stdout: "", stderr: "", documentEdit: result };
    }
    return fail(call, `Unknown PDF edit tool: ${call.name}`);
  } catch (error) { return fail(call, safeError(error instanceof Error ? error.message : "PDF edit failed.")); }
}
