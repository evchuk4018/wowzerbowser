import "server-only";

import type { ChatToolCall, ChatToolResult } from "../../../lib/chat-protocol";
import {
  MAX_IMAGE_FOLLOWUP_QUESTION_LENGTH,
  ChatImageError,
  isValidChatImageId,
} from "../../../lib/chat-image";
import {
  chatToolResultForImageError,
  inspectChatImage,
} from "../chat/chat-image-service";

export { INSPECT_IMAGE_TOOL_DEFINITION, INSPECT_IMAGE_TOOL_NAME, availableImageTools } from "./image-tool-manifest";

export type InspectImageToolContext = {
  ownerId: string;
  conversationId: string;
  jobId?: string;
  /** Image ids copied from the server-validated request history. */
  allowedImageIds: readonly string[];
  signal: AbortSignal;
  responseDeadlineAt: number;
};

function parseInspectImageArguments(call: ChatToolCall): { imageId: string; question: string } {
  let value: unknown;
  try {
    value = JSON.parse(call.arguments);
  } catch {
    throw new ChatImageError("invalid_arguments", "The model returned invalid inspect_image arguments.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ChatImageError("invalid_arguments", "inspect_image arguments must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "imageId" && key !== "question")) {
    throw new ChatImageError("invalid_arguments", "inspect_image received an unexpected argument.");
  }
  const imageId = typeof record.imageId === "string" ? record.imageId.trim() : "";
  if (!isValidChatImageId(imageId)) {
    throw new ChatImageError("invalid_arguments", "inspect_image imageId is invalid.");
  }
  const question = typeof record.question === "string" ? record.question.trim() : "";
  if (!question || question.length > MAX_IMAGE_FOLLOWUP_QUESTION_LENGTH) {
    throw new ChatImageError("invalid_arguments", "inspect_image question is invalid.");
  }
  return { imageId, question };
}

export async function executeInspectImageTool(
  call: ChatToolCall,
  context: InspectImageToolContext,
): Promise<ChatToolResult> {
  const startedAt = Date.now();
  try {
    const args = parseInspectImageArguments(call);
    if (!context.allowedImageIds.includes(args.imageId)) {
      throw new ChatImageError("image_not_allowed", "That image is not available in the current request.", 403);
    }
    const deadline = AbortSignal.timeout(Math.max(0, context.responseDeadlineAt - Date.now()));
    const result = await inspectChatImage({
      ownerId: context.ownerId,
      conversationId: context.conversationId,
      jobId: context.jobId,
      imageId: args.imageId,
      question: args.question,
      toolCallId: call.id,
      signal: AbortSignal.any([context.signal, deadline]),
    });
    return {
      id: call.id,
      name: call.name,
      ok: true,
      stdout: "",
      stderr: "",
      durationMs: Date.now() - startedAt,
      image: result,
    };
  } catch (error) {
    return {
      ...chatToolResultForImageError(call.id, error),
      durationMs: Date.now() - startedAt,
    };
  }
}
