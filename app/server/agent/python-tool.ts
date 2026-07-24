import "server-only";

import type { ChatArtifact, ChatToolCall, ChatToolResult } from "../../../lib/chat-protocol";
import { registerArtifact } from "../artifacts/artifact-store";
import { isModalConfigured, ModalPythonExecutor } from "../modal/modal-python-executor";
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
    const result = await executor.run(parseArguments(call.arguments));
    const artifacts: ChatArtifact[] = (result.artifacts ?? []).map((item) =>
      registerArtifact({
        ownerId,
        conversationId,
        name: item.path.split("/").pop() || "artifact",
        path: item.path,
        size: item.size,
        sha256: item.sha256,
        contentType: contentTypeFor(item.path),
      }),
    );
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
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  return "application/octet-stream";
}
