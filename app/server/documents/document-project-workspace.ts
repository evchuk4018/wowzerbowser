import "server-only";
import { createHash } from "node:crypto";
import type { ModalPythonExecutor } from "../modal/modal-python-executor";
import { DOCUMENT_PROJECT_LIMITS, documentRevisionManifestPath, documentRevisionOutputPath, documentRevisionRoot, documentRevisionSourcePath, sourceContentType, validateDocumentProjectManifest, type DocumentProjectManifestV1, type DocumentProjectSourceFile } from "../../../lib/document-project";
import type { PythonToolInput } from "../../../lib/chat-protocol";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export async function captureRevisionWorkspace(input: { executor: ModalPythonExecutor; projectId: string; revisionId: string; pythonInput: PythonToolInput; outputPath: string; outputFilename: string; outputContentType: DocumentProjectManifestV1["outputContentType"]; outputSha256: string; jobId: string | null; parentRevisionId?: string | null }): Promise<DocumentProjectManifestV1> {
  const { executor, projectId, revisionId } = input;
  await executor.createWorkspaceDirectory(documentRevisionRoot(projectId, revisionId));
  const sourceFiles: DocumentProjectSourceFile[] = [];
  let completeness: DocumentProjectManifestV1["sourceCompleteness"] = "complete";
  let entrypoint: string;
  if (input.pythonInput.code !== undefined) {
    entrypoint = documentRevisionSourcePath(projectId, revisionId, "main.py");
    const bytes = new TextEncoder().encode(input.pythonInput.code);
    await executor.writeWorkspaceFile(entrypoint, bytes);
    sourceFiles.push({ path: entrypoint, size: bytes.length, sha256: hash(bytes), contentType: sourceContentType(entrypoint) });
    // Inline programs can reference arbitrary pre-existing workspace data; make
    // the compatibility limitation explicit rather than claiming completeness.
    if (/\b(?:open|Path)\s*\(/.test(input.pythonInput.code)) completeness = "entrypoint-only";
  } else {
    const source = input.pythonInput.file!;
    const slash = source.lastIndexOf("/"); const sourceRoot = slash < 0 ? "" : source.slice(0, slash);
    const candidates = sourceRoot ? await executor.listWorkspaceTree(sourceRoot) : [{ path: source, size: (await executor.readWorkspaceFile(source)).length }];
    let total = 0;
    for (const candidate of candidates) {
      if (candidate.path === input.outputPath || candidate.size < 1 || candidate.size > DOCUMENT_PROJECT_LIMITS.maxFileBytes) continue;
      const relative = sourceRoot ? candidate.path.slice(sourceRoot.length + 1) : candidate.path;
      const destination = documentRevisionSourcePath(projectId, revisionId, relative);
      const bytes = await executor.readWorkspaceFile(candidate.path); total += bytes.length;
      if (total > DOCUMENT_PROJECT_LIMITS.maxSourceBytes) throw new Error("Document source tree exceeds the capture limit.");
      await executor.writeWorkspaceFile(destination, bytes);
      sourceFiles.push({ path: destination, size: bytes.length, sha256: hash(bytes), contentType: sourceContentType(destination) });
    }
    entrypoint = documentRevisionSourcePath(projectId, revisionId, sourceRoot ? source.slice(sourceRoot.length + 1) : source);
  }
  const outputPath = documentRevisionOutputPath(projectId, revisionId, input.outputFilename);
  await executor.copyWorkspaceFile(input.outputPath, outputPath);
  const outputBytes = await executor.readWorkspaceFile(outputPath);
  if (hash(outputBytes) !== input.outputSha256) throw new Error("Canonical document output hash does not match the generated artifact.");
  const manifest = validateDocumentProjectManifest({ schemaVersion: 1, projectId, revisionId, parentRevisionId: input.parentRevisionId ?? null, origin: "generated", createdAt: new Date().toISOString(), createdByJobId: input.jobId, entrypoint, outputPath, outputFilename: input.outputFilename, outputContentType: input.outputContentType, sourceFiles, outputSha256: input.outputSha256, sourceCompleteness: completeness });
  await executor.writeWorkspaceFile(documentRevisionManifestPath(projectId, revisionId), new TextEncoder().encode(JSON.stringify(manifest, null, 2)));
  return manifest;
}
