import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { parsePdfNatively } from "../chat/pdf-native-parser";
import { renderPdfPages } from "../chat/pdf-page-renderer";
import { ingestPdf } from "../chat/chat-document-service";
import { getAuthorizedDocumentStorageObject } from "../chat/chat-document-store";
import { createDocumentProjectStore } from "./document-project-store";
import { documentRevisionOutputPath, documentRevisionSourcePath, validateDocumentProjectManifest, type DocumentProjectManifestV1 } from "../../../lib/document-project";
import { registerArtifact } from "../artifacts/artifact-store";
import type { ChatArtifact, ChatDocumentEditResult } from "../../../lib/chat-protocol";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const safeFilename = (value: string) => {
  const name = value.replace(/[\\/\u0000-\u001f\u007f]/g, "_").trim().slice(0, 160);
  if (!name || name === "." || name === ".." || !name.toLowerCase().endsWith(".pdf")) return "edited-document.pdf";
  return name;
};

export type RevisionFinalizeInput = {
  ownerId: string;
  conversationId: string;
  projectId: string;
  parentRevisionId: string;
  baseDocumentId: string;
  revisionId: string;
  outputFilename: string;
  bytes: Uint8Array;
  method: Extract<ChatDocumentEditResult, { kind: "revision" }>['method'];
  changedPages: number[];
  warnings?: string[];
  jobId?: string | null;
  alreadyRegistered?: boolean;
  origin?: "generated" | "uploaded";
  sourceFileBytes?: Uint8Array;
};

export async function finalizeDocumentRevision(input: RevisionFinalizeInput): Promise<{ result: Extract<ChatDocumentEditResult, { kind: "revision" }>; artifact: ChatArtifact; manifest: DocumentProjectManifestV1 }> {
  if (!input.bytes.byteLength) throw new Error("The edited PDF is empty.");
  const filename = safeFilename(input.outputFilename);
  const parsed = await parsePdfNatively(input.bytes);
  if (parsed.pageCount < 1) throw new Error("The edited PDF must contain at least one page.");
  const pagesToRender = [...new Set(input.changedPages)].filter((page) => page >= 1 && page <= parsed.pageCount).slice(0, 50);
  const rendered = await renderPdfPages(input.bytes, pagesToRender.length ? pagesToRender : [1], { scale: 1 });
  if (rendered.some((page) => page.width < 1 || page.height < 1)) throw new Error("The edited PDF contains an invalid rendered page.");
  const store = createDocumentProjectStore();
  const sourceFiles: DocumentProjectManifestV1['sourceFiles'] = [];
  const parent = await store.getRevision({ ownerId: input.ownerId, conversationId: input.conversationId, projectId: input.projectId, revisionId: input.parentRevisionId });
  const parentManifest = parent?.manifest as DocumentProjectManifestV1 | null;
  if ((input.origin ?? "generated") === "generated" && parentManifest?.sourceFiles) {
    for (const file of parentManifest.sourceFiles) sourceFiles.push({ ...file, path: documentRevisionSourcePath(input.projectId, input.revisionId, file.path.split("/source/").pop() ?? file.path) });
  }
  if ((input.origin ?? "generated") === "uploaded") {
    const bytes = input.sourceFileBytes ?? new Uint8Array([0]);
    sourceFiles.push({ path: documentRevisionSourcePath(input.projectId, input.revisionId, "input.pdf"), size: bytes.byteLength, sha256: sha256(bytes), contentType: "application/pdf" });
  }
  const entrypoint = (input.origin ?? "generated") === "uploaded" ? documentRevisionSourcePath(input.projectId, input.revisionId, "input.pdf") : sourceFiles.find((file) => file.path.endsWith(`/${parentManifest?.entrypoint.split("/source/").pop() ?? "main.py"}`))?.path ?? documentRevisionSourcePath(input.projectId, input.revisionId, "main.py");
  const outputPath = documentRevisionOutputPath(input.projectId, input.revisionId, filename);
  const manifest = validateDocumentProjectManifest({ schemaVersion: 1, projectId: input.projectId, revisionId: input.revisionId, parentRevisionId: input.parentRevisionId, origin: input.origin ?? "generated", createdAt: new Date().toISOString(), createdByJobId: input.jobId ?? null, entrypoint, outputPath, outputFilename: filename, outputContentType: "application/pdf", sourceFiles: sourceFiles.length ? sourceFiles : [{ path: entrypoint, size: 1, sha256: sha256(new Uint8Array([0])), contentType: "text/x-python" }], outputSha256: sha256(input.bytes), sourceCompleteness: input.origin === "uploaded" ? "entrypoint-only" : (parentManifest?.sourceCompleteness ?? "entrypoint-only") });
  if (!input.alreadyRegistered) await store.registerRevision({ ownerId: input.ownerId, conversationId: input.conversationId, manifest, renderedDocumentId: randomUUID() });
  else await store.updateRevisionManifest({ ownerId: input.ownerId, conversationId: input.conversationId, projectId: input.projectId, revisionId: input.revisionId, manifest });
  try {
    if (input.origin === "uploaded" && input.sourceFileBytes) await store.uploadSourceFiles({ ownerId: input.ownerId, conversationId: input.conversationId, manifest, files: new Map([[manifest.sourceFiles[0].path, input.sourceFileBytes]]) });
    const documentId = randomUUID();
    const document = await ingestPdf({ ownerId: input.ownerId, conversationId: input.conversationId, pdfId: documentId, filename, bytes: input.bytes, jobId: input.jobId ?? undefined, projectId: input.projectId, revisionId: input.revisionId, parentRevisionId: input.parentRevisionId, origin: input.origin ?? "generated", editable: true, sourceCompleteness: manifest.sourceCompleteness ?? undefined });
    await store.updateRenderedDocumentId({ ownerId: input.ownerId, conversationId: input.conversationId, projectId: input.projectId, revisionId: input.revisionId, renderedDocumentId: document.id });
    const storedDocument = await getAuthorizedDocumentStorageObject(input.ownerId, input.conversationId, document.id);
    if (!storedDocument) throw new Error("The rendered document storage object could not be loaded.");
    const artifact = await registerArtifact({ ownerId: input.ownerId, conversationId: input.conversationId, name: filename, storageObjectId: storedDocument.objectId, contentType: "application/pdf", projectId: input.projectId, revisionId: input.revisionId, parentRevisionId: input.parentRevisionId, origin: input.origin ?? "generated", editable: true, sourceCompleteness: manifest.sourceCompleteness ?? undefined });
    await store.finalizeRevision({ ownerId: input.ownerId, conversationId: input.conversationId, projectId: input.projectId, revisionId: input.revisionId });
    return { result: { kind: "revision", projectId: input.projectId, revisionId: input.revisionId, parentRevisionId: input.parentRevisionId, documentId: document.id, method: input.method, changedPages: pagesToRender, warnings: input.warnings ?? [] }, artifact, manifest };
  } catch (error) {
    await store.markRevisionFailed({ ownerId: input.ownerId, conversationId: input.conversationId, projectId: input.projectId, revisionId: input.revisionId }).catch(() => undefined);
    throw error;
  }
}
