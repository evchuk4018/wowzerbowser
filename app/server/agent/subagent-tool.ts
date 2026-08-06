import "server-only";

import type { ChatArtifact, ChatStreamEvent, ChatToolCall, ChatToolResult } from "../../../lib/chat-protocol";
import type { ChatSource } from "../../../lib/chat-citations";

const MAX_TASK_LENGTH = 12_000;
const MAX_CONTEXT_LENGTH = 16_000;
const MAX_OUTPUT_LENGTH = 40_000;
const MAX_SOURCES = 40;

export type SubagentRunRequest = {
  task: string;
  context?: string;
  callId: string;
  signal: AbortSignal;
};

export type SubagentRunResult = {
  ok: boolean;
  stdout: string;
  stderr?: string;
  artifacts?: ChatArtifact[];
  sources?: ChatSource[];
};

export type SubagentToolEventSink = (event: ChatStreamEvent) => Promise<void> | void;

export type SubagentToolContext = {
  signal: AbortSignal;
  run: (request: SubagentRunRequest, onEvent?: SubagentToolEventSink) => Promise<SubagentRunResult>;
  onUpdate?: (update: {
    taskId: string;
    title: string;
    status: "queued" | "running" | "completed" | "failed";
    summary?: string;
  }) => Promise<void> | void;
};

function fail(call: ChatToolCall, stderr: string, durationMs?: number): ChatToolResult {
  return { id: call.id, name: call.name, ok: false, stdout: "", stderr, ...(durationMs === undefined ? {} : { durationMs }) };
}

function parseArguments(call: ChatToolCall): { task: string; context?: string } {
  let value: unknown;
  try {
    value = JSON.parse(call.arguments || "{}");
  } catch {
    throw new Error("Invalid subagent arguments.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid subagent arguments.");
  const input = value as Record<string, unknown>;
  if (typeof input.task !== "string" || !input.task.trim() || input.task.trim().length > MAX_TASK_LENGTH) {
    throw new Error("task is required and must be at most 12,000 characters.");
  }
  if (input.context !== undefined && (typeof input.context !== "string" || input.context.length > MAX_CONTEXT_LENGTH)) {
    throw new Error("context must be a string of at most 16,000 characters.");
  }
  return {
    task: input.task.trim(),
    ...(typeof input.context === "string" && input.context.trim() ? { context: input.context.trim() } : {}),
  };
}

function taskTitle(task: string): string {
  const compact = task.replace(/\s+/g, " ").trim();
  return compact.length <= 120 ? compact : `${compact.slice(0, 117)}...`;
}

export async function executeSubagentTool(call: ChatToolCall, context: SubagentToolContext): Promise<ChatToolResult> {
  const startedAt = Date.now();
  let input: { task: string; context?: string };
  try {
    input = parseArguments(call);
  } catch (error) {
    return fail(call, error instanceof Error ? error.message : "Invalid subagent arguments.", Date.now() - startedAt);
  }

  const title = taskTitle(input.task);
  const update = async (status: "queued" | "running" | "completed" | "failed", summary?: string): Promise<void> => {
    try {
      await context.onUpdate?.({ taskId: call.id, title, status, ...(summary ? { summary } : {}) });
    } catch {
      // Activity presentation is best effort and must never fail the delegated run.
    }
  };

  await update("queued");
  await update("running");
  try {
    const result = await context.run({ task: input.task, ...(input.context ? { context: input.context } : {}), callId: call.id, signal: context.signal }, async (event) => {
      if (event.type !== "tool_call") return;
      try {
        await context.onUpdate?.({
          taskId: call.id,
          title,
          status: "running",
          ...(event.type === "tool_call" ? { summary: `Using ${event.call.name}.` } : {}),
        });
      } catch {
        // Activity presentation is best effort.
      }
    });
    const stdout = result.stdout.slice(0, MAX_OUTPUT_LENGTH);
    await update(result.ok ? "completed" : "failed", result.ok ? "Delegated task complete." : result.stderr?.slice(0, 240) || "Delegated task failed.");
    return {
      id: call.id,
      name: call.name,
      ok: result.ok,
      stdout,
      stderr: result.stderr ?? "",
      durationMs: Date.now() - startedAt,
      ...(result.stdout.length > MAX_OUTPUT_LENGTH ? { stdoutTruncated: true } : {}),
      ...(result.artifacts?.length ? { artifacts: result.artifacts.slice(0, 20) } : {}),
      subagent: {
        kind: "delegation",
        taskId: call.id,
        title,
        sources: (result.sources ?? []).slice(0, MAX_SOURCES),
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Delegated task failed.";
    await update("failed", message.slice(0, 240));
    return fail(call, message, Date.now() - startedAt);
  }
}

export { RUN_SUBAGENT_TOOL_NAME } from "./subagent-tool-manifest";
