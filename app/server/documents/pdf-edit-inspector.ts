import "server-only";

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { ChatDocumentEditResult } from "../../../lib/chat-protocol";
import { getAuthorizedDocument } from "../chat/chat-document-store";
import { parsePdfNatively } from "../chat/pdf-native-parser";
import { createDocumentProjectStore } from "./document-project-store";

export type PdfEditInspection = Extract<ChatDocumentEditResult, { kind: "inspection" }>;

function hasSignature(bytes: Uint8Array): boolean {
  const text = new TextDecoder("latin1").decode(bytes);
  return /\/ByteRange\s*\[|\/Type\s*\/Sig\b/.test(text);
}

function hasEncryption(bytes: Uint8Array): boolean {
  return /\/Encrypt\b/.test(new TextDecoder("latin1").decode(bytes));
}

export async function inspectPdfEditability(input: {
  ownerId: string;
  conversationId: string;
  documentId: string;
  pages?: number[];
  bytes?: Uint8Array;
}): Promise<PdfEditInspection> {
  const document = await getAuthorizedDocument(input.ownerId, input.conversationId, input.documentId);
  if (!document || document.contentType !== "application/pdf") throw new Error("Document is not an authorized PDF.");
  const bytes = input.bytes;
  if (!bytes) throw new Error("PDF bytes are required for inspection.");
  const encrypted = hasEncryption(bytes);
  const signed = hasSignature(bytes);
  const native = await parsePdfNatively(bytes);
  const requested = input.pages?.length ? new Set(input.pages) : null;
  const pages = native.pages.filter((page) => !requested || requested.has(page.pageNumber)).map((page) => ({
    pageNumber: page.pageNumber,
    nativeTextCharacters: page.text.length,
    imageCount: page.imageObjectCount,
    likelyScanned: native.pageOcrDecisions[page.pageNumber - 1]?.needsOcr ?? (!page.text.trim() && page.imageObjectCount > 0),
    rotation: 0,
    width: page.pageWidth,
    height: page.pageHeight,
  }));
  let hasAcroForm = false;
  const rotations = new Map<number, number>();
  let loadingTask: ReturnType<typeof getDocument> | undefined;
  try {
    loadingTask = getDocument({ data: Uint8Array.from(bytes), isImageDecoderSupported: false, isOffscreenCanvasSupported: false, useWasm: false, useWorkerFetch: false, verbosity: 0 });
    const pdf = await loadingTask.promise;
    for (const page of pages) {
      const pdfPage = await pdf.getPage(page.pageNumber);
      rotations.set(page.pageNumber, pdfPage.rotate || 0);
      const annotations = await pdfPage.getAnnotations({ intent: "display" });
      if (annotations.some((annotation) => (annotation as { fieldType?: string; subtype?: string }).fieldType === "Tx" || (annotation as { subtype?: string }).subtype === "Widget")) hasAcroForm = true;
      pdfPage.cleanup();
    }
  } finally {
    await loadingTask?.destroy().catch(() => undefined);
  }
  const project = document.projectId && document.revisionId ? await createDocumentProjectStore().getProjectRevisionMetadata({ ownerId: input.ownerId, conversationId: input.conversationId, projectId: document.projectId, revisionId: document.revisionId }).catch(() => null) : null;
  const sourceBacked = Boolean(document.projectId && document.revisionId && (document.origin === "generated" || project?.origin === "generated"));
  const sourceCompleteness = document.sourceCompleteness ?? (project?.sourceCompleteness ?? null);
  const recommendedMethod = encrypted || signed
    ? "unsupported"
    : sourceBacked && sourceCompleteness === "complete"
      ? "source-rerender"
      : pages.some((page) => page.likelyScanned)
        ? "overlay"
        : "pdf-objects";
  return {
    kind: "inspection",
    documentId: input.documentId,
    projectId: document.projectId ?? null,
    revisionId: document.revisionId ?? null,
    origin: sourceBacked ? "generated" : "uploaded",
    sourceBacked,
    sourceCompleteness,
    encrypted,
    signed,
    hasAcroForm,
    pageCount: native.pageCount,
    pages: pages.map((page) => ({ ...page, rotation: rotations.get(page.pageNumber) ?? 0 })),
    recommendedMethod,
  };
}
