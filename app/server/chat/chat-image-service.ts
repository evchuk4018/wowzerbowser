import "server-only";

import { createHash } from "node:crypto";
import {
  MAX_CHAT_IMAGES_PER_TURN,
  MAX_IMAGE_ANALYSIS_RESPONSE_LENGTH,
  MAX_IMAGE_FOLLOWUP_QUESTION_LENGTH,
  type ChatImageAttachment,
  type ChatImageContentType,
  type ChatImageToolResult,
  ChatImageError,
  sanitizeChatImageName,
  validateChatImageBytes,
} from "../../../lib/chat-image";
import { estimateUsageFromText } from "../../../lib/usage-pricing";
import type { ChatToolResult } from "../../../lib/chat-protocol";
import type { ChatToolCall } from "../../../lib/chat-protocol";
import { recordUsage } from "../usage/usage-store";
import { askOpenRouterAboutImage } from "../../providers/openrouter/openrouter-image-adapter";
import { OPENROUTER_FREE_MODEL } from "../../providers/openrouter/openrouter-config";
import {
  attachmentFromUploadRecord,
  chatImageStoragePath,
  claimChatImageUpload,
  completeChatImageUpload,
  downloadChatImageObject,
  downloadChatImageObjectByPath,
  ensureChatImageConversation,
  failChatImageUpload,
  findChatImageAttachment,
  findChatImagePreviewAttachment,
  waitForChatImageUpload,
  uploadChatImageObject,
} from "./chat-image-store";

export type ChatImageUpload = {
  id: string;
  name: string | null;
  declaredType: string | null;
  bytes: Uint8Array;
};

export type ChatImageServiceOptions = {
  signal?: AbortSignal;
  jobId?: string;
};

const VISIBLE_TEXT_PROMPT = [
  "Determine whether this image contains visible text.",
  "",
  "If text is present, transcribe it faithfully. Preserve useful line breaks.",
  "Do not correct, complete, or guess unclear text. Mark unreadable portions as",
  "[unclear].",
  "",
  "If no visible text is present, respond with exactly:",
  "NONE",
].join("\n");

const MAIN_VISUALS_PROMPT = [
  "Describe the main things visibly present in this image.",
  "",
  "Include the important subjects, objects, interface elements, chart elements,",
  "or scene components needed for another model to understand the image.",
  "",
  "Only state details supported by visible evidence. Clearly mark uncertainty.",
  "Do not infer hidden identities, motives, events, or facts.",
  "Keep the answer concise.",
].join("\n");

const FOLLOWUP_SYSTEM_PROMPT = [
  "Answer the supplied question using only visible evidence from the image.",
  "Do not guess. Explicitly say when the requested detail is absent, obscured,",
  "unreadable, or uncertain.",
].join("\n");

async function recordImageUsage(input: {
  ownerId: string;
  conversationId: string;
  jobId?: string;
  requestId: string;
  requestKind: "image_text_analysis" | "image_visual_analysis" | "image_followup";
  model: string | null;
  usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number; cachedPromptTokens?: number; reasoningTokens?: number } | null;
  prompt: string;
  answer: string;
}): Promise<void> {
  const model = input.model ?? OPENROUTER_FREE_MODEL;
  await recordUsage({
    ownerId: input.ownerId,
    provider: "openrouter",
    model,
    requestKind: input.requestKind,
    requestId: input.requestId,
    round: 0,
    usage: input.usage ?? estimateUsageFromText(input.prompt, input.answer),
    source: input.usage ? "exact" : "estimated",
    conversationId: input.conversationId,
    jobId: input.jobId,
  });
}

function hashImageBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function storedImageFailure(error: string | null): ChatImageError {
  return new ChatImageError(
    "analysis_failed",
    error || "Image analysis failed. Your draft was kept; please retry.",
    502,
  );
}

function normalizeImageFailure(error: unknown, signal?: AbortSignal): ChatImageError {
  if (error instanceof ChatImageError) return error;
  if (signal?.aborted) return new ChatImageError("cancelled", "Image analysis was cancelled.", 499);
  return new ChatImageError("analysis_failed", "Image analysis failed. Your draft was kept; please retry.", 502);
}

async function analyzeOneChatImage(input: {
  ownerId: string;
  conversationId: string;
  userMessageId: string;
  upload: ChatImageUpload;
  contentType: ChatImageContentType;
  contentHash: string;
  options: ChatImageServiceOptions;
}): Promise<ChatImageAttachment> {
  const { ownerId, conversationId, userMessageId, upload, contentType, contentHash, options } = input;
  const claimed = await claimChatImageUpload({
    ownerId,
    conversationId,
    imageId: upload.id,
    userMessageId,
    jobId: options.jobId,
    storagePath: chatImageStoragePath(ownerId, conversationId, userMessageId, upload.id),
    name: sanitizeChatImageName(upload.name),
    contentType,
    size: upload.bytes.byteLength,
    contentHash,
  });

  if (!claimed.claimed) {
    const settled = claimed.record.status === "processing"
      ? await waitForChatImageUpload(ownerId, conversationId, upload.id, options.signal)
      : claimed.record;
    if (!settled) throw new ChatImageError("storage", "Image upload metadata could not be loaded.", 503);
    if (settled.status === "complete") {
      const attachment = attachmentFromUploadRecord(settled);
      if (attachment) return attachment;
      throw new ChatImageError("storage", "Image analysis metadata is incomplete.", 503);
    }
    if (settled.status === "failed") throw storedImageFailure(settled.error);
    throw new ChatImageError("analysis_in_progress", "Image analysis is still in progress. Please retry shortly.", 409);
  }

  const claimToken = claimed.record.claimToken;
  if (!claimToken) throw new ChatImageError("storage", "Image upload claim is incomplete.", 503);
  try {
    await uploadChatImageObject(claimed.record.storagePath, upload.bytes, contentType, options.signal);
    const storedBytes = await downloadChatImageObjectByPath(claimed.record.storagePath, contentType);
    const [text, visuals] = await Promise.all([
      askOpenRouterAboutImage(VISIBLE_TEXT_PROMPT, storedBytes, contentType, { signal: options.signal }),
      askOpenRouterAboutImage(MAIN_VISUALS_PROMPT, storedBytes, contentType, { signal: options.signal }),
    ]);
    const visibleText = text.content.trim() === "NONE" ? null : text.content.slice(0, MAX_IMAGE_ANALYSIS_RESPONSE_LENGTH);
    const mainVisuals = visuals.content.slice(0, MAX_IMAGE_ANALYSIS_RESPONSE_LENGTH);
    await Promise.allSettled([
      recordImageUsage({ ownerId, conversationId, jobId: options.jobId, requestId: `${upload.id}:text`, requestKind: "image_text_analysis", model: text.model, usage: text.usage, prompt: VISIBLE_TEXT_PROMPT, answer: text.content }),
      recordImageUsage({ ownerId, conversationId, jobId: options.jobId, requestId: `${upload.id}:visual`, requestKind: "image_visual_analysis", model: visuals.model, usage: visuals.usage, prompt: MAIN_VISUALS_PROMPT, answer: visuals.content }),
    ]);
    const completed = await completeChatImageUpload(ownerId, conversationId, upload.id, claimToken, {
      status: "complete",
      visibleText,
      mainVisuals,
      textModel: text.model,
      visualModel: visuals.model,
      textUsage: text.usage,
      visualUsage: visuals.usage,
    });
    const attachment = attachmentFromUploadRecord(completed);
    if (!attachment) throw new ChatImageError("storage", "Image analysis metadata is incomplete.", 503);
    return attachment;
  } catch (error) {
    const failure = normalizeImageFailure(error, options.signal);
    try {
      await failChatImageUpload(ownerId, conversationId, upload.id, claimToken, failure.message);
    } catch {
      throw new ChatImageError("storage", "Image failure metadata could not be saved.", 503);
    }
    throw failure;
  }
}

export async function analyzeAndStoreChatImages(
  ownerId: string,
  conversationId: string,
  userMessageId: string,
  inputs: ChatImageUpload[],
  options: ChatImageServiceOptions = {},
): Promise<ChatImageAttachment[]> {
  if (inputs.length < 1 || inputs.length > MAX_CHAT_IMAGES_PER_TURN) {
    throw new ChatImageError("image_count", `Attach between 1 and ${MAX_CHAT_IMAGES_PER_TURN} images.`);
  }
  if (!options.jobId) {
    throw new ChatImageError("invalid_request", "Image uploads must be bound to a chat job.");
  }
  const ids = new Set<string>();
  for (const input of inputs) {
    if (ids.has(input.id)) throw new ChatImageError("duplicate_image_id", "Each image ID may only appear once per turn.");
    ids.add(input.id);
  }
  const prepared = inputs.map((input) => ({
    input,
    contentType: validateChatImageBytes(input.bytes, input.declaredType ?? undefined),
    contentHash: hashImageBytes(input.bytes),
  }));
  await ensureChatImageConversation(ownerId, conversationId);
  return Promise.all(prepared.map(({ input, contentType, contentHash }) => analyzeOneChatImage({
    ownerId,
    conversationId,
    userMessageId,
    upload: input,
    contentType,
    contentHash,
    options,
  })));
}

export async function readChatImagePreviewForOwner(input: {
  ownerId: string;
  conversationId: string;
  imageId: string;
}): Promise<{ bytes: Uint8Array; contentType: ChatImageContentType }> {
  const image = await findChatImagePreviewAttachment(input.ownerId, input.conversationId, input.imageId);
  return {
    bytes: await downloadChatImageObject(input.ownerId, input.conversationId, image),
    contentType: image.contentType,
  };
}

export async function inspectChatImage(input: {
  ownerId: string;
  conversationId: string;
  imageId: string;
  question: string;
  toolCallId: string;
  signal?: AbortSignal;
}): Promise<ChatImageToolResult> {
  const question = input.question.trim();
  if (!question || question.length > MAX_IMAGE_FOLLOWUP_QUESTION_LENGTH) {
    throw new ChatImageError("invalid_question", "The image question must be between 1 and 1,000 characters.");
  }
  const image = await findChatImageAttachment(input.ownerId, input.conversationId, input.imageId);
  const bytes = await downloadChatImageObject(input.ownerId, input.conversationId, image);
  const answer = await askOpenRouterAboutImage(`${FOLLOWUP_SYSTEM_PROMPT}\n\nQuestion: ${question}`, bytes, image.contentType, { signal: input.signal });
  await recordImageUsage({
    ownerId: input.ownerId,
    conversationId: input.conversationId,
    requestId: input.toolCallId,
    requestKind: "image_followup",
    model: answer.model,
    usage: answer.usage,
    prompt: question,
    answer: answer.content,
  }).catch(() => undefined);
  return {
    kind: "image",
    imageId: image.id,
    question,
    answer: answer.content,
    model: answer.model,
  };
}

export function chatToolResultForImageError(callId: string, error: unknown): ChatToolResult {
  const message = error instanceof ChatImageError ? error.message : "Image inspection failed.";
  return { id: callId, name: "inspect_image", ok: false, stdout: "", stderr: message };
}

export const chatImagePrompts = { VISIBLE_TEXT_PROMPT, MAIN_VISUALS_PROMPT, FOLLOWUP_SYSTEM_PROMPT } as const;

export async function analyzeDocumentImage(bytes: Uint8Array, contentType: ChatImageContentType, signal?: AbortSignal): Promise<{ visibleText: string | null; mainVisuals: string | null }> {
  const storedLimit = 2_000;
  const [text, visuals] = await Promise.all([
    askOpenRouterAboutImage(VISIBLE_TEXT_PROMPT, bytes, contentType, { signal }),
    askOpenRouterAboutImage(MAIN_VISUALS_PROMPT, bytes, contentType, { signal }),
  ]);
  return {
    visibleText: text.content.trim() === "NONE" ? null : text.content.slice(0, storedLimit),
    mainVisuals: visuals.content.trim() ? visuals.content.slice(0, storedLimit) : null,
  };
}

export const INSPECT_IMAGE_TOOL_NAME = "inspect_image";
export const INSPECT_IMAGE_TOOL_DEFINITION = {
  type: "function" as const,
  function: {
    name: INSPECT_IMAGE_TOOL_NAME,
    description: "Ask a focused question about an image attached to the current conversation. Use this when the existing text and visual summaries do not contain enough information to answer the user accurately.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["imageId", "question"],
      properties: {
        imageId: { type: "string", minLength: 1, maxLength: 128 },
        question: { type: "string", minLength: 1, maxLength: MAX_IMAGE_FOLLOWUP_QUESTION_LENGTH },
      },
    },
  },
} as const;

export function availableImageTools(hasImage = true) {
  return hasImage ? [INSPECT_IMAGE_TOOL_DEFINITION] : [];
}

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
  if (typeof record.imageId !== "string" || !record.imageId.trim() || record.imageId.length > 128) {
    throw new ChatImageError("invalid_arguments", "inspect_image imageId is invalid.");
  }
  if (typeof record.question !== "string" || !record.question.trim() || record.question.length > MAX_IMAGE_FOLLOWUP_QUESTION_LENGTH) {
    throw new ChatImageError("invalid_arguments", "inspect_image question is invalid.");
  }
  return { imageId: record.imageId.trim(), question: record.question.trim() };
}

export async function executeInspectImageTool(
  call: ChatToolCall,
  ownerId: string,
  conversationId: string,
  signal: AbortSignal,
  responseDeadlineAt: number,
): Promise<ChatToolResult> {
  const startedAt = Date.now();
  try {
    const args = parseInspectImageArguments(call);
    const deadline = AbortSignal.timeout(Math.max(0, responseDeadlineAt - Date.now()));
    const result = await inspectChatImage({
      ownerId,
      conversationId,
      imageId: args.imageId,
      question: args.question,
      toolCallId: call.id,
      signal: AbortSignal.any([signal, deadline]),
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
