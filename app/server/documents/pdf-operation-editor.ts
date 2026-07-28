import "server-only";

import { randomUUID } from "node:crypto";
import type { ModalPythonExecutor } from "../modal/modal-python-executor";
import type { ChatDocumentEditResult } from "../../../lib/chat-protocol";
import { documentRevisionOutputPath, documentRevisionRoot, documentRevisionSourcePath, validateDocumentProjectManifest } from "../../../lib/document-project";
import { createHash } from "node:crypto";
import { createDocumentProjectStore } from "./document-project-store";
import { getAuthorizedDocument, downloadAuthorizedDocumentBytes } from "../chat/chat-document-store";
import { findChatImageAttachment, downloadChatImageObject } from "../chat/chat-image-store";
import { inspectPdfEditability } from "./pdf-edit-inspector";
import { finalizeDocumentRevision } from "./document-revision-service";
import { PDF_OPERATION_SCRIPT } from "./pdf-operation-script.mjs";

export type PdfOperation =
  | { type: "delete_pages"; pages: number[] }
  | { type: "reorder_pages"; order: number[] }
  | { type: "rotate_pages"; pages: number[]; degrees: 90 | 180 | 270 }
  | { type: "insert_blank_page"; afterPage: number; width?: number; height?: number }
  | { type: "merge_document"; sourceDocumentId: string; afterPage: number }
  | { type: "redact_text"; query: string; pages?: number[]; expectedOccurrences?: number }
  | { type: "replace_text"; query: string; replacement: string; pages?: number[]; expectedOccurrences: number; fontSize?: number }
  | { type: "add_text"; page: number; x: number; y: number; width: number; height: number; text: string; fontSize: number; align?: "left" | "center" | "right" }
  | { type: "add_image"; page: number; imageId: string; x: number; y: number; width: number; height: number }
  | { type: "watermark"; text: string; opacity: number; pages?: number[] }
  | { type: "set_form_field"; fieldName: string; value: string };

function finite(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(field + " must be finite and non-negative.");
  return value;
}
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export function validateOperations(operations: PdfOperation[], inspection: Awaited<ReturnType<typeof inspectPdfEditability>>): void {
  if (operations.length < 1 || operations.length > 30) throw new Error("PDF edits must contain between 1 and 30 operations.");
  let pageCount = inspection.pageCount;
  for (const operation of operations) {
    if (operation.type === "delete_pages") {
      if (!operation.pages.length || operation.pages.some((page) => !Number.isInteger(page) || page < 1 || page > pageCount)) throw new Error("delete_pages contains an invalid page.");
      pageCount -= new Set(operation.pages).size;
      if (pageCount < 1) throw new Error("An edit cannot delete every page.");
    } else if (operation.type === "reorder_pages") {
      if (operation.order.length !== pageCount || new Set(operation.order).size !== pageCount || operation.order.some((page) => !Number.isInteger(page) || page < 1 || page > pageCount)) throw new Error("reorder_pages must specify every current page exactly once.");
    } else if (operation.type === "rotate_pages") {
      if (operation.pages.some((page) => !Number.isInteger(page) || page < 1 || page > pageCount)) throw new Error("rotate_pages contains an invalid page.");
    } else if (operation.type === "insert_blank_page") {
      if (!Number.isInteger(operation.afterPage) || operation.afterPage < 0 || operation.afterPage > pageCount) throw new Error("insert_blank_page has an invalid page position.");
      pageCount++;
      if (operation.width !== undefined) finite(operation.width, "width");
      if (operation.height !== undefined) finite(operation.height, "height");
    } else if (operation.type === "merge_document") {
      if (!Number.isInteger(operation.afterPage) || operation.afterPage < 0 || operation.afterPage > pageCount) throw new Error("merge_document has an invalid page position.");
    } else if (operation.type === "add_text" || operation.type === "add_image") {
      const page = inspection.pages.find((candidate) => candidate.pageNumber === operation.page);
      if (!page || finite(operation.x, "x") < 0 || finite(operation.y, "y") < 0 || finite(operation.width, "width") < 0 || finite(operation.height, "height") < 0 || operation.x + operation.width > page.width || operation.y + operation.height > page.height) throw new Error("Overlay coordinates are outside the page bounds.");
    }
    if ("query" in operation && (operation.query.length < 1 || operation.query.length > 4096)) throw new Error("Text queries are bounded and required.");
    if ("replacement" in operation && operation.replacement.length > 16384) throw new Error("Replacement text is too long.");
    if ((operation.type === "replace_text" || operation.type === "redact_text") && inspection.pages.some((page) => (!operation.pages || operation.pages.includes(page.pageNumber)) && page.likelyScanned)) throw new Error("Text replacement and text redaction require selectable text coordinates; use an explicit geometric overlay for scanned pages.");
    if ("expectedOccurrences" in operation && (typeof operation.expectedOccurrences !== "number" || !Number.isSafeInteger(operation.expectedOccurrences) || operation.expectedOccurrences < 0)) throw new Error("expectedOccurrences must be a non-negative integer.");
    if (operation.type === "watermark" && (!Number.isFinite(operation.opacity) || operation.opacity < 0 || operation.opacity > 1)) throw new Error("Watermark opacity must be between 0 and 1.");
    if (operation.type === "set_form_field" && (typeof operation.fieldName !== "string" || !operation.fieldName.trim() || operation.fieldName.length > 512 || typeof operation.value !== "string" || operation.value.length > 16_384)) throw new Error("Form field name or value is invalid.");
  }
}

export async function editPdfOperations(input: { ownerId: string; conversationId: string; documentId: string; operations: PdfOperation[]; outputFilename?: string; executor: ModalPythonExecutor; jobId?: string | null }): Promise<{ result: Extract<ChatDocumentEditResult, { kind: "revision" }>; artifact: import("../../../lib/chat-protocol").ChatArtifact }> {
  const target = await getAuthorizedDocument(input.ownerId, input.conversationId, input.documentId);
  if (!target || target.contentType !== "application/pdf") throw new Error("Document is not an authorized PDF.");
  const bytes = await downloadAuthorizedDocumentBytes(input.ownerId, input.conversationId, input.documentId);
  if (!bytes) throw new Error("The source PDF bytes are unavailable.");
  const inspection = await inspectPdfEditability({ ownerId: input.ownerId, conversationId: input.conversationId, documentId: input.documentId, bytes });
  if (inspection.encrypted || inspection.signed) throw new Error("Encrypted or signed PDFs are not editable in this safe path.");
  validateOperations(input.operations, inspection);
  const projectId = target.projectId ?? randomUUID();
  const parentRevisionId = target.revisionId ?? randomUUID();
  const revisionId = randomUUID();
  const store = createDocumentProjectStore();
  if (!target.projectId) await store.createProject({ ownerId: input.ownerId, conversationId: input.conversationId, projectId, title: target.name, origin: "uploaded" });
  await input.executor.createWorkspaceDirectory(documentRevisionRoot(projectId, revisionId));
  const inputPath = documentRevisionSourcePath(projectId, revisionId, "input.pdf");
  const outputFilename = (input.outputFilename ?? ("edited-" + target.name)).replace(/[\\/\u0000-\u001f\u007f]/g, "_").slice(0, 160) || "edited-document.pdf";
  const outputPath = documentRevisionOutputPath(projectId, revisionId, outputFilename);
  await input.executor.writeWorkspaceFile(inputPath, bytes);
  const provisionalManifest = validateDocumentProjectManifest({ schemaVersion: 1, projectId, revisionId, parentRevisionId, origin: "uploaded", createdAt: new Date().toISOString(), createdByJobId: input.jobId ?? null, entrypoint: inputPath, outputPath, outputFilename, outputContentType: "application/pdf", sourceFiles: [{ path: inputPath, size: bytes.byteLength, sha256: digest(bytes), contentType: "application/pdf" }], outputSha256: digest(bytes), sourceCompleteness: "entrypoint-only" });
  await store.registerRevision({ ownerId: input.ownerId, conversationId: input.conversationId, manifest: provisionalManifest, renderedDocumentId: randomUUID() });
  const documents: Record<string, string> = {};
  const images: Record<string, string> = {};
  for (const operation of input.operations) {
    if (operation.type === "merge_document") {
      const source = await getAuthorizedDocument(input.ownerId, input.conversationId, operation.sourceDocumentId);
      if (!source || source.contentType !== "application/pdf") throw new Error("Merged document is not authorized.");
      const sourceBytes = await downloadAuthorizedDocumentBytes(input.ownerId, input.conversationId, operation.sourceDocumentId);
      if (!sourceBytes) throw new Error("Merged document bytes are unavailable.");
      const path = documentRevisionSourcePath(projectId, revisionId, "merge-" + operation.sourceDocumentId + ".pdf");
      await input.executor.writeWorkspaceFile(path, sourceBytes);
      documents[operation.sourceDocumentId] = "/workspace/" + path;
    }
    if (operation.type === "add_image") {
      const image = await findChatImageAttachment(input.ownerId, input.conversationId, operation.imageId);
      const imageBytes = await downloadChatImageObject(input.ownerId, input.conversationId, image);
      const path = documentRevisionSourcePath(projectId, revisionId, "image-" + operation.imageId);
      await input.executor.writeWorkspaceFile(path, imageBytes);
      images[operation.imageId] = "/workspace/" + path;
    }
  }
  try {
    const execution = await input.executor.run({ code: PDF_OPERATION_SCRIPT, stdin: JSON.stringify({ operations: input.operations, documents, images }), args: ["/workspace/" + inputPath, "/workspace/" + outputPath], artifacts: [outputPath] });
    if (execution.exitCode !== 0) throw new Error(execution.stderr || "The PDF edit failed.");
    const outputBytes = await input.executor.readWorkspaceFile(outputPath);
    const parsed = JSON.parse(execution.stdout.trim().split("\n").at(-1) || "{}") as { changedPages?: number[]; warnings?: string[] };
    const finalized = await finalizeDocumentRevision({ ownerId: input.ownerId, conversationId: input.conversationId, projectId, parentRevisionId, baseDocumentId: input.documentId, revisionId, outputFilename, bytes: outputBytes, method: inspection.pages.some((page) => page.likelyScanned) ? "overlay" : "pdf-objects", changedPages: parsed.changedPages || [], warnings: parsed.warnings || [], jobId: input.jobId, origin: "uploaded", sourceFileBytes: bytes, alreadyRegistered: true });
    return { result: finalized.result, artifact: finalized.artifact };
  } catch (error) {
    await store.markRevisionFailed({ ownerId: input.ownerId, conversationId: input.conversationId, projectId, revisionId }).catch(() => undefined);
    throw error;
  }
}
