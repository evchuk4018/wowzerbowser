import "server-only";

import type { ChatToolCall, ChatToolResult } from "../../../lib/chat-protocol";
import { ASK_USER_TOOL_NAME } from "./ask-user-tool-manifest";
import { createUserQuestion } from "../user-questions/user-question-repository";
import { queueUserQuestionDiscordDelivery } from "../discord/discord-user-question-delivery-adapter";

type AskUserToolContext = {
  ownerId: string;
  conversationId: string;
  jobId?: string;
  signal?: AbortSignal;
  executionOptions?: { onUserQuestion?: (questionId: string) => void; automationRunId?: string; source?: string };
};

function parse(call: ChatToolCall): { question: string; context?: string; options?: string[] } {
  let value: unknown;
  try { value = JSON.parse(call.arguments); } catch { throw new Error("ask_user arguments must be valid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("ask_user arguments must be an object.");
  const record = value as Record<string, unknown>;
  const question = typeof record.question === "string" ? record.question.trim() : "";
  if (!question) throw new Error("question is required.");
  if (question.length > 2000) throw new Error("question is too long.");
  const context = record.context === undefined ? undefined : String(record.context).slice(0, 4000);
  const options = record.options === undefined ? undefined : (() => {
    if (!Array.isArray(record.options)) throw new Error("options must be an array.");
    return (record.options as unknown[]).filter((option): option is string => typeof option === "string" && option.trim().length > 0).map((option) => option.trim().slice(0, 200)).slice(0, 8);
  })();
  return { question, ...(context ? { context } : {}), ...(options ? { options } : {}) };
}

export async function executeAskUserTool(call: ChatToolCall, context: AskUserToolContext): Promise<ChatToolResult> {
  const startedAt = Date.now();
  try {
    const input = parse(call);
    const executionOptions = context.executionOptions ?? {};
    const source = executionOptions.source ?? (executionOptions.automationRunId ? "automation" : "chat");
    let questionId: string | null = null;
    try {
      const question = await createUserQuestion({
        ownerId: context.ownerId,
        source: source as "chat" | "automation",
        conversationId: context.conversationId,
        chatJobId: context.jobId ?? null,
        automationRunId: executionOptions.automationRunId ?? null,
        question: input.question,
        context: input.context ?? null,
        options: input.options ?? null,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      });
      questionId = question.id;
      await queueUserQuestionDiscordDelivery({ ownerId: context.ownerId, questionId: question.id, question: input.question, context: input.context ?? null, conversationId: context.conversationId }).catch(() => undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create user question.";
      if (String(message).includes("does not exist") || String(message).includes("relation")) {
        questionId = `pending-${Date.now()}`;
      } else {
        throw error;
      }
    }
    executionOptions.onUserQuestion?.(questionId ?? `pending-${Date.now()}`);
    const stdout = [
      `Question escalated to the user (id: ${questionId}).`,
      `Question: ${input.question}`,
      ...(input.context ? [`Context: ${input.context}`] : []),
      ...(input.options?.length ? [`Options: ${input.options.join(" | ")}`] : []),
      "The run will pause until the user replies via Discord or the web UI. Do not call complete_automation_run until an answer is provided.",
    ].join("\n");
    return { id: call.id, name: call.name, ok: true, stdout, stderr: "", durationMs: Date.now() - startedAt };
  } catch (error) {
    const message = error instanceof Error ? error.message : "ask_user failed.";
    return { id: call.id, name: ASK_USER_TOOL_NAME, ok: false, stdout: "", stderr: message.slice(0, 4000), durationMs: Date.now() - startedAt };
  }
}
