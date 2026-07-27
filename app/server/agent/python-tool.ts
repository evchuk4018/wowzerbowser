import "server-only";

import type { ChatArtifact, ChatToolCall, ChatToolResult } from "../../../lib/chat-protocol";
import { registerArtifact } from "../artifacts/artifact-store";
import { isModalConfigured, ModalPythonExecutor } from "../modal/modal-python-executor";
import { validatePythonToolInput } from "../../../lib/python-tool-policy";
import { registerGeneratedDocumentProvenance } from "../documents/generated-document-provenance";
import {
  PYTHON_TOOL_DEFINITION,
  PYTHON_TOOL_NAME,
} from "./python-tool-manifest";

export { PYTHON_TOOL_DEFINITION, PYTHON_TOOL_NAME } from "./python-tool-manifest";

export function availableChatTools() {
  return isModalConfigured() ? [PYTHON_TOOL_DEFINITION] : [];
}

function parseArguments(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("The model returned invalid JSON for run_python arguments.");
  }
}

export async function executePythonTool(
  call: ChatToolCall,
  executor: ModalPythonExecutor,
  ownerId: string,
  conversationId: string,
  onDocumentArtifact?: (artifact: ChatArtifact, bytes: Uint8Array) => Promise<void>,
): Promise<ChatToolResult> {
  const startedAt = Date.now();
  if (call.name !== PYTHON_TOOL_NAME) {
    return {
      id: call.id,
      name: call.name,
      ok: false,
      stdout: "",
      stderr: `Unknown tool: ${call.name}`,
      durationMs: Date.now() - startedAt,
    };
  }
  try {
    const pythonInput = validatePythonToolInput(parseArguments(call.arguments));
    const result = await executor.run(pythonInput);
    const artifacts: ChatArtifact[] = [];
    for (const item of result.artifacts ?? []) {
      const contentType = contentTypeFor(item.path);
      if (contentType === "application/pdf" || contentType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
        const provenance = await registerGeneratedDocumentProvenance({ ownerId, conversationId, jobId: call.id, pythonInput, executor, artifact: item });
        artifacts.push(registerArtifact({
          ownerId, conversationId, name: item.path.split("/").pop() || "artifact",
          path: provenance.canonicalOutputPath, size: item.size, sha256: item.sha256, contentType,
          projectId: provenance.projectId, revisionId: provenance.revisionId,
          parentRevisionId: provenance.manifest.parentRevisionId, origin: "generated", editable: true,
          sourceCompleteness: provenance.sourceCompleteness,
        }));
      } else artifacts.push(registerArtifact({
        ownerId,
        conversationId,
        name: item.path.split("/").pop() || "artifact",
        path: item.path,
        size: item.size,
        sha256: item.sha256,
        contentType,
      }));
    }
    if (onDocumentArtifact) {
      for (const artifact of artifacts.filter((item) => item.contentType === "application/pdf" || item.contentType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document")) {
        const descriptor = (result.artifacts ?? []).find((item) => item.path.split("/").pop() === artifact.name);
        if (descriptor) {
          const provenancePath = artifact.projectId && artifact.revisionId ? `documents/${artifact.projectId}/revisions/${artifact.revisionId}/output/${artifact.name}` : descriptor.path;
          await onDocumentArtifact(artifact, await executor.readArtifact(provenancePath));
        }
      }
    }
    return {
      id: call.id,
      name: call.name,
      ok: result.exitCode === 0,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      durationMs: Date.now() - startedAt,
      ...(result.timedOut ? { timedOut: true } : {}),
      ...(result.stdoutTruncated ? { stdoutTruncated: true } : {}),
      ...(result.stderrTruncated ? { stderrTruncated: true } : {}),
      ...(artifacts.length ? { artifacts } : {}),
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Python execution failed.";
    return {
      id: call.id,
      name: call.name,
      ok: false,
      stdout: "",
      stderr: message,
      durationMs: Date.now() - startedAt,
      ...(/time(?:d)?\s*out|timeout/i.test(message) ? { timedOut: true } : {}),
    };
  }
}

function contentTypeFor(path: string): string {
  const extension = path.toLowerCase().split(".").pop();
  if (extension === "json") return "application/json";
  if (extension === "csv") return "text/csv";
  if (extension === "txt" || extension === "md" || extension === "py") return "text/plain; charset=utf-8";
  if (extension === "png") return "image/png";
  if (extension === "pdf") return "application/pdf";
  if (extension === "docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  return "application/octet-stream";
}
