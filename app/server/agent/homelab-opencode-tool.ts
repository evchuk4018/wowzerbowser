import "server-only";

import type { ChatToolCall, ChatToolResult } from "../../../lib/chat-protocol";
import { parseHomelabOpencodeRequest } from "../../../lib/homelab-opencode-protocol";
import { runHomelabOpencodeTurn } from "../homelab/homelab-opencode-service";

function parse(call: ChatToolCall): Record<string, unknown> {
  try {
    const value = JSON.parse(call.arguments);
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {}
  throw new Error("The model returned invalid homelab tool arguments.");
}

export async function executeHomelabOpencodeTool(call: ChatToolCall, signal?: AbortSignal): Promise<ChatToolResult> {
  const startedAt = Date.now();
  try {
    const input = parse(call);
    const request = parseHomelabOpencodeRequest(input);
    const result = await runHomelabOpencodeTurn(request, { signal });
    const truncatedStdout = result.rawStdout.length > 48_000 ? `${result.rawStdout.slice(0, 48_000)}\n[stdout truncated]` : result.rawStdout;
    const truncatedStderr = result.rawStderr.length > 8_000 ? `${result.rawStderr.slice(0, 8_000)}\n[stderr truncated]` : result.rawStderr;
    const lines: string[] = [];
    lines.push(`sessionId: ${result.sessionId}`);
    lines.push(`status: ${result.status}${result.timedOut ? " (timed_out)" : ""}${result.exitCode !== null ? ` exitCode=${result.exitCode}` : ""}`);
    lines.push(`durationMs: ${result.durationMs}`);
    lines.push(`endedWithQuestion: ${result.endedWithQuestion}`);
    lines.push("");
    if (result.finalText) {
      lines.push("--- opencode output ---");
      lines.push(result.finalText.slice(0, 32_000));
      lines.push("--- end output ---");
      lines.push("");
    } else {
      lines.push("(no text output)");
      lines.push("");
    }
    if (result.events.length) {
      const preview = result.events.slice(0, 20).map((event) => JSON.stringify(event).slice(0, 500)).join("\n");
      lines.push(`events (${result.events.length} total, showing up to 20):`);
      lines.push(preview);
      lines.push("");
    }
    if (truncatedStderr) {
      lines.push("stderr:");
      lines.push(truncatedStderr);
      lines.push("");
    }
    if (!result.rawStdout && result.rawStderr) {
      lines.push("raw stdout was empty — see stderr above.");
    }
    const stdout = lines.join("\n").slice(0, 48_000);
    const ok = result.status === "completed";
    const stderr = ok ? "" : (result.finalText ? "" : truncatedStderr || `Homelab opencode ${result.status}.`) + (result.timedOut ? " The turn timed out." : "");
    return {
      id: call.id,
      name: call.name,
      ok,
      stdout,
      stderr: ok ? "" : stderr.slice(0, 4_000),
      durationMs: Date.now() - startedAt,
      ...(result.timedOut ? { timedOut: true } : {}),
      ...(stdout.length >= 48_000 ? { stdoutTruncated: true } : {}),
      ...(stderr.length >= 4_000 ? { stderrTruncated: true } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Homelab opencode tool failed.";
    return { id: call.id, name: call.name, ok: false, stdout: "", stderr: message.slice(0, 4_000), durationMs: Date.now() - startedAt };
  }
}
