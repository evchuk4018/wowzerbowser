import "server-only";

import { createHash } from "node:crypto";
import type { ChatDocumentEditResult } from "../../../lib/chat-protocol";
import { parsePdfNatively } from "../chat/pdf-native-parser";
import { renderPdfPages } from "../chat/pdf-page-renderer";
import { createDocumentProjectStore } from "./document-project-store";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const pageHashes = async (bytes: Uint8Array, count: number) => {
  const hashes: string[] = [];
  for (let page = 1; page <= Math.min(count, 100); page += 1) {
    const [rendered] = await renderPdfPages(bytes, [page], { scale: 1 });
    hashes.push(digest(rendered.bytes));
  }
  return hashes;
};

export async function compareDocumentRevisions(input: { ownerId: string; conversationId: string; projectId: string; leftRevisionId: string; rightRevisionId: string }): Promise<Extract<ChatDocumentEditResult, { kind: "comparison" }>> {
  const store = createDocumentProjectStore();
  const [left, right, leftBytes, rightBytes] = await Promise.all([
    store.getRevision({ ...input, revisionId: input.leftRevisionId }),
    store.getRevision({ ...input, revisionId: input.rightRevisionId }),
    store.downloadRevisionOutput({ ...input, revisionId: input.leftRevisionId }),
    store.downloadRevisionOutput({ ...input, revisionId: input.rightRevisionId }),
  ]);
  if (!left || !right || !leftBytes || !rightBytes) throw new Error("The requested revisions are not available.");
  const [leftPdf, rightPdf] = await Promise.all([parsePdfNatively(leftBytes), parsePdfNatively(rightBytes)]);
  const [leftHashes, rightHashes] = await Promise.all([pageHashes(leftBytes, leftPdf.pageCount), pageHashes(rightBytes, rightPdf.pageCount)]);
  const changedPages = Array.from({ length: Math.max(leftHashes.length, rightHashes.length) }, (_, index) => index + 1).filter((page) => leftHashes[page - 1] !== rightHashes[page - 1]);
  const leftManifest = left.manifest as { sourceFiles?: Array<{ path: string; sha256: string }>; outputSha256?: string; outputContentType?: string };
  const rightManifest = right.manifest as { sourceFiles?: Array<{ path: string; sha256: string }>; outputSha256?: string; outputContentType?: string };
  const rightFiles = new Map((rightManifest.sourceFiles ?? []).map((file) => [file.path, file.sha256]));
  const sourceFilesChanged = (leftManifest.sourceFiles ?? []).filter((file) => rightFiles.get(file.path) !== file.sha256).map((file) => file.path);
  return { kind: "comparison", projectId: input.projectId, leftRevisionId: input.leftRevisionId, rightRevisionId: input.rightRevisionId, pageCountChange: rightPdf.pageCount - leftPdf.pageCount, changedPages, sourceFilesChanged, leftOutput: { size: leftBytes.byteLength, sha256: digest(leftBytes) }, rightOutput: { size: rightBytes.byteLength, sha256: digest(rightBytes) }, method: "pdf-objects" };
}
