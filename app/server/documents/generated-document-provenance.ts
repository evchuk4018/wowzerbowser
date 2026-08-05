import "server-only";
import { randomUUID } from "node:crypto";
import type { PythonToolInput } from "../../../lib/chat-protocol";
import { outputContentType, type DocumentProjectManifestV1 } from "../../../lib/document-project";
import type { LocalExecArtifact, LocalPythonExecutor } from "../python/local-python-executor";
import { createDocumentProjectStore } from "./document-project-store";
import { captureRevisionWorkspace } from "./document-project-workspace";

export type GeneratedDocumentProvenance = { projectId: string; revisionId: string; canonicalOutputPath: string; entrypoint: string; sourceCompleteness: DocumentProjectManifestV1["sourceCompleteness"]; manifest: DocumentProjectManifestV1 };
export async function registerGeneratedDocumentProvenance(input: { ownerId: string; conversationId: string; jobId: string | null; pythonInput: PythonToolInput; executor: LocalPythonExecutor; artifact: LocalExecArtifact }): Promise<GeneratedDocumentProvenance> {
  const contentType = outputContentType(input.artifact.path);
  if (!contentType) throw new Error("Generated document must be a PDF or DOCX file.");
  const projectId = randomUUID(); const revisionId = randomUUID(); const renderedDocumentId = randomUUID();
  const filename = input.artifact.path.split("/").pop() || (contentType === "application/pdf" ? "document.pdf" : "document.docx");
  const store = createDocumentProjectStore();
  await store.createProject({ ownerId: input.ownerId, conversationId: input.conversationId, projectId, title: filename });
  let manifest: DocumentProjectManifestV1 | undefined;
  try {
    manifest = await captureRevisionWorkspace({ executor: input.executor, projectId, revisionId, pythonInput: input.pythonInput, outputPath: input.artifact.path, outputFilename: filename, outputContentType: contentType, outputSha256: input.artifact.sha256, jobId: input.jobId });
    await store.registerRevision({ ownerId: input.ownerId, conversationId: input.conversationId, manifest, renderedDocumentId });
    const files = new Map<string, Uint8Array>();
    for (const file of manifest.sourceFiles) files.set(file.path, await input.executor.readWorkspaceFile(file.path));
    await store.uploadSourceFiles({ ownerId: input.ownerId, conversationId: input.conversationId, manifest, files });
    await store.finalizeRevision({ ownerId: input.ownerId, conversationId: input.conversationId, projectId, revisionId });
    return { projectId, revisionId, canonicalOutputPath: manifest.outputPath, entrypoint: manifest.entrypoint, sourceCompleteness: manifest.sourceCompleteness, manifest };
  } catch (error) {
    if (manifest) await store.markRevisionFailed({ ownerId: input.ownerId, conversationId: input.conversationId, projectId, revisionId }).catch(() => undefined);
    throw new Error(`Generated document provenance registration failed: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}
