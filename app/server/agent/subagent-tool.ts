import "server-only";

import type { ChatArtifact, ChatStreamEvent, ChatToolCall, ChatToolResult } from "../../../lib/chat-protocol";
import type { ChatSource } from "../../../lib/chat-citations";
import { runtimeConfigSnapshot } from "../config/runtime-config-service";

const MAX_SAFE_TASK_LENGTH = 50_000;
const MAX_SAFE_CONTEXT_LENGTH = 100_000;
const MAX_SAFE_OUTPUT_LENGTH = 250_000;
const MAX_SAFE_SOURCES = 200;
const MAX_SAFE_ARTIFACTS = 100;

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
  const configuration = runtimeConfigSnapshot();
  const maxTaskLength = Math.min(configuration.subagentMaxTaskCharacters, MAX_SAFE_TASK_LENGTH);
  const maxContextLength = Math.min(configuration.subagentMaxContextCharacters, MAX_SAFE_CONTEXT_LENGTH);
  let value: unknown;
  try {
    value = JSON.parse(call.arguments || "{}");
  } catch {
    throw new Error("Invalid subagent arguments.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid subagent arguments.");
  const input = value as Record<string, unknown>;
  if (typeof input.task !== "string" || !input.task.trim() || input.task.trim().length > maxTaskLength) {
    throw new Error(`task is required and must be at most ${maxTaskLength.toLocaleString()} characters.`);
  }
  if (input.context !== undefined && (typeof input.context !== "string" || input.context.length > maxContextLength)) {
    throw new Error(`context must be a string of at most ${maxContextLength.toLocaleString()} characters.`);
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
    const configuration = runtimeConfigSnapshot();
    const maxOutputLength = Math.min(configuration.subagentMaxOutputCharacters, MAX_SAFE_OUTPUT_LENGTH);
    const maxSources = Math.min(configuration.subagentMaxSources, MAX_SAFE_SOURCES);
    const maxArtifacts = Math.min(configuration.subagentMaxArtifacts, MAX_SAFE_ARTIFACTS);
    const stdout = result.stdout.slice(0, maxOutputLength);
    const stderr = (result.stderr ?? "").slice(0, maxOutputLength);
    await update(result.ok ? "completed" : "failed", result.ok ? "Delegated task complete." : result.stderr?.slice(0, 240) || "Delegated task failed.");
    return {
      id: call.id,
      name: call.name,
      ok: result.ok,
      stdout,
      stderr,
      durationMs: Date.now() - startedAt,
      ...(result.stdout.length > maxOutputLength ? { stdoutTruncated: true } : {}),
      ...(result.stderr && result.stderr.length > stderr.length ? { stderrTruncated: true } : {}),
      ...(result.artifacts?.length ? { artifacts: result.artifacts.slice(0, maxArtifacts) } : {}),
      subagent: {
        kind: "delegation",
        taskId: call.id,
        title,
        sources: (result.sources ?? []).slice(0, maxSources),
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Delegated task failed.";
    await update("failed", message.slice(0, 240));
    return fail(call, message, Date.now() - startedAt);
  }
}

export { RUN_SUBAGENT_TOOL_NAME } from "./subagent-tool-manifest";
