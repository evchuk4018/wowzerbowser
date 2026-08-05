import "server-only";

import type { ChatToolCall, ChatToolResult } from "../../../lib/chat-protocol";
import type { CustomToolTestResult } from "../../../lib/custom-tool-protocol";
import { validateJsonAgainstSchema } from "../../../lib/custom-tool-protocol";
import { PYTHON_TOOL_LIMITS, runIsolatedPythonTool } from "../python/local-python-executor";
import { decryptCustomToolSecret } from "./custom-tool-crypto";
import type { ExecutableCustomTool } from "./custom-tool-repository";

function secretEnvironment(tool: ExecutableCustomTool): Record<string, string> {
  return Object.fromEntries(tool.encryptedSecrets.map((item) => [item.name, decryptCustomToolSecret({
    ciphertext: item.ciphertext, nonce: item.nonce, tag: item.auth_tag,
  })]));
}

function redact(value: string, secrets: string[]): string {
  let result = value;
  for (const secret of secrets.filter((item) => item.length > 0).sort((a, b) => b.length - a.length)) {
    result = result.split(secret).join("[REDACTED]");
  }
  return result;
}

export async function runCustomTool(tool: ExecutableCustomTool, input: unknown): Promise<CustomToolTestResult> {
  const startedAt = Date.now();
  try {
    validateJsonAgainstSchema(input, tool.inputSchema);
    const environment = secretEnvironment(tool);
    const secretValues = Object.values(environment);
    const result = await runIsolatedPythonTool(tool.pythonSource, input, environment, startedAt + PYTHON_TOOL_LIMITS.callTimeoutMs);
    const stdout = redact(result.stdout, secretValues);
    const stderr = redact(result.stderr, secretValues);
    if (result.exitCode !== 0) return { ok: false, stdout, stderr: stderr || "Tool execution failed.", exitCode: result.exitCode, durationMs: Date.now() - startedAt };
    try {
      return { ok: true, output: JSON.parse(stdout), stdout, stderr, exitCode: 0, durationMs: Date.now() - startedAt };
    } catch {
      return { ok: false, stdout, stderr: "Tool output must be one valid JSON value.", exitCode: 0, durationMs: Date.now() - startedAt };
    }
  } catch (error) {
    const timedOut = /time(?:d)?\s*out|deadline/i.test(error instanceof Error ? error.message : "");
    return {
      ok: false, stdout: "", stderr: timedOut ? "Tool execution timed out." : error instanceof Error ? error.message : "Tool execution failed.",
      durationMs: Date.now() - startedAt, ...(timedOut ? { timedOut: true } : {}),
    };
  }
}

export async function executeCustomToolCall(call: ChatToolCall, tool: ExecutableCustomTool): Promise<ChatToolResult> {
  let input: unknown;
  try {
    input = JSON.parse(call.arguments);
  } catch {
    return { id: call.id, name: call.name, ok: false, stdout: "", stderr: "The tool arguments were not valid JSON." };
  }
  const result = await runCustomTool(tool, input);
  return {
    id: call.id, name: call.name, ok: result.ok,
    stdout: result.ok ? JSON.stringify(result.output) : result.stdout,
    stderr: result.stderr, exitCode: result.exitCode, durationMs: result.durationMs,
    ...(result.timedOut ? { timedOut: true } : {}),
  };
}
