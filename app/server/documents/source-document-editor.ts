import "server-only";

import { randomUUID, createHash } from "node:crypto";
import type { ModalPythonExecutor } from "../modal/modal-python-executor";
import type { ChatDocumentEditResult } from "../../../lib/chat-protocol";
import { documentRevisionOutputPath, documentRevisionRoot, documentRevisionSourcePath, sourceContentType, validateDocumentProjectManifest, type DocumentProjectManifestV1 } from "../../../lib/document-project";
import { createDocumentProjectStore } from "./document-project-store";
import { finalizeDocumentRevision } from "./document-revision-service";

type Patch = { type: "replace_text"; path: string; oldText: string; newText: string; expectedOccurrences: number } | { type: "unified_diff"; path: string; patch: string };
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const safeRelative = (path: string) => { const value = path.replaceAll("\\", "/").replace(/^\.\//, ""); if (!value || value.split("/").some((part) => !part || part === "." || part === "..") || !/^[A-Za-z0-9_./ -]+$/.test(value)) throw new Error("Source patch path is invalid."); return value; };

export function replaceText(text: string, patch: Extract<Patch, { type: "replace_text" }>): string {
  if (!Number.isSafeInteger(patch.expectedOccurrences) || patch.expectedOccurrences < 0 || patch.oldText.length > 64 * 1024 || patch.newText.length > 64 * 1024) throw new Error("Source replacement is invalid or too large.");
  const occurrences = text.split(patch.oldText).length - 1;
  if (occurrences !== patch.expectedOccurrences) throw new Error(`Expected ${patch.expectedOccurrences} occurrences but found ${occurrences}.`);
  return text.split(patch.oldText).join(patch.newText);
}

export function applyUnifiedDiff(text: string, diff: string): string {
  if (diff.length > 64 * 1024) throw new Error("Unified diff is too large.");
  const lines = text.split(/\r?\n/); const diffLines = diff.split(/\r?\n/); let cursor = 0; const output: string[] = [];
  for (const line of diffLines) {
    if (!line || line.startsWith("---") || line.startsWith("+++") || line.startsWith("@@")) {
      if (line.startsWith("@@")) { const match = /@@\s+-(\d+)/.exec(line); if (!match) throw new Error("Unified diff hunk header is invalid."); const target = Number(match[1]) - 1; if (target < cursor || target > lines.length) throw new Error("Unified diff hunk is out of range."); output.push(...lines.slice(cursor, target)); cursor = target; }
      continue;
    }
    if (line.startsWith(" ")) { if (lines[cursor] !== line.slice(1)) throw new Error("Unified diff context does not match."); output.push(lines[cursor++]); }
    else if (line.startsWith("-")) { if (lines[cursor] !== line.slice(1)) throw new Error("Unified diff removal does not match."); cursor += 1; }
    else if (line.startsWith("+")) output.push(line.slice(1));
    else throw new Error("Unified diff contains an invalid line.");
  }
  output.push(...lines.slice(cursor)); return output.join("\n");
}

export async function editSourceBackedDocument(input: { ownerId: string; conversationId: string; documentId: string; projectId: string; baseRevisionId: string; patches: Patch[]; outputFilename?: string; executor: ModalPythonExecutor; jobId?: string | null }): Promise<{ result: Extract<ChatDocumentEditResult, { kind: "revision" }>; artifact: import("../../../lib/chat-protocol").ChatArtifact }> {
  if (input.patches.length > 20) throw new Error("At most 20 source patches are allowed.");
  const store = createDocumentProjectStore();
  const base = await store.getRevision({ ownerId: input.ownerId, conversationId: input.conversationId, projectId: input.projectId, revisionId: input.baseRevisionId }).catch(() => null);
  if (!base) throw new Error("The authorized base revision was not found.");
  const projectId = input.projectId; const parent = base.manifest as DocumentProjectManifestV1; if (parent.origin !== "generated") throw new Error("The base revision is not source-backed.");
  const revisionId = randomUUID(); const files = new Map<string, Uint8Array>();
  for (const file of parent.sourceFiles) { const bytes = await store.downloadRevisionSourceFile({ ownerId: input.ownerId, conversationId: input.conversationId, projectId, revisionId: input.baseRevisionId, relativePath: file.path }); if (!bytes) throw new Error("A source file is unavailable."); if (hash(bytes) !== file.sha256) throw new Error("A source file hash no longer matches the base manifest."); files.set(file.path.split("/source/").pop() ?? file.path, bytes); }
  for (const patch of input.patches) { const path = safeRelative(patch.path); const bytes = files.get(path); if (!bytes) throw new Error("Patch path is not listed in the base revision manifest."); const current = new TextDecoder().decode(bytes); const updated = patch.type === "replace_text" ? replaceText(current, patch) : applyUnifiedDiff(current, patch.patch); files.set(path, new TextEncoder().encode(updated)); }
  await input.executor.createWorkspaceDirectory(documentRevisionRoot(projectId, revisionId));
  const sourceFiles = [...files.entries()].map(([path, bytes]) => ({ path: documentRevisionSourcePath(projectId, revisionId, path), size: bytes.byteLength, sha256: hash(bytes), contentType: sourceContentType(path) }));
  for (const [path, bytes] of files) await input.executor.writeWorkspaceFile(documentRevisionSourcePath(projectId, revisionId, path), bytes);
  const outputFilename = (input.outputFilename ?? parent.outputFilename).replace(/[\\/\u0000-\u001f\u007f]/g, "_").slice(0, 160) || "edited-document.pdf";
  const entrypointRelative = parent.entrypoint.split("/source/").pop() ?? "main.py";
  const entrypoint = documentRevisionSourcePath(projectId, revisionId, entrypointRelative);
  const outputPath = documentRevisionOutputPath(projectId, revisionId, outputFilename);
  const manifest = validateDocumentProjectManifest({ ...parent, revisionId, parentRevisionId: input.baseRevisionId, entrypoint, outputPath, outputFilename, sourceFiles, outputSha256: parent.outputSha256 });
  await store.registerRevision({ ownerId: input.ownerId, conversationId: input.conversationId, manifest, renderedDocumentId: randomUUID() });
  try {
    const execution = await input.executor.run({ file: entrypoint, artifacts: [parent.outputFilename] });
    if (execution.exitCode !== 0) throw new Error(execution.stderr || "Saved source entrypoint failed.");
    const pdfArtifacts = (execution.artifacts ?? []).filter((artifact) => artifact.path.toLowerCase().endsWith(".pdf"));
    if (pdfArtifacts.length !== 1) throw new Error("The saved entrypoint did not produce exactly one expected PDF output.");
    const outputBytes = await input.executor.readWorkspaceFile(parent.outputFilename);
    await input.executor.writeWorkspaceFile(outputPath, outputBytes);
    const finalManifest = { ...manifest, outputSha256: hash(outputBytes) };
    await store.updateRevisionManifest({ ownerId: input.ownerId, conversationId: input.conversationId, projectId, revisionId, manifest: finalManifest });
    await store.uploadSourceFiles({ ownerId: input.ownerId, conversationId: input.conversationId, manifest: finalManifest, files: new Map(sourceFiles.map((file) => [file.path, files.get(file.path.split("/source/").pop()!)!])) });
    const finalized = await finalizeDocumentRevision({ ownerId: input.ownerId, conversationId: input.conversationId, projectId, parentRevisionId: input.baseRevisionId, baseDocumentId: input.documentId, revisionId, outputFilename, bytes: outputBytes, method: "source-rerender", changedPages: [], warnings: [], jobId: input.jobId, alreadyRegistered: true });
    return { result: finalized.result, artifact: finalized.artifact };
  } catch (error) { await store.markRevisionFailed({ ownerId: input.ownerId, conversationId: input.conversationId, projectId, revisionId }).catch(() => undefined); throw error; }
}
