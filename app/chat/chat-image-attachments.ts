"use client";

import {
  CHAT_IMAGE_CONTENT_TYPES,
  CHAT_IMAGE_MAX_BYTES,
  CHAT_IMAGE_MAX_COUNT,
  type ChatImageAttachment,
} from "../../lib/chat-protocol";

export const ACCEPTED_CHAT_IMAGE_TYPES = CHAT_IMAGE_CONTENT_TYPES;
export const MAX_CHAT_IMAGES_PER_TURN = CHAT_IMAGE_MAX_COUNT;
export const MAX_CHAT_IMAGE_BYTES = CHAT_IMAGE_MAX_BYTES;

export type ChatImageUploadContext = { conversationId: string; userMessageId: string; jobId: string };
export type PendingChatImage = {
  id: string;
  file: File;
  previewUrl: string;
  uploadContext?: ChatImageUploadContext;
  uploadPromise?: Promise<UploadedChatImage>;
};
export type UploadedChatImage = ChatImageAttachment;

export function validateChatImages(files: readonly File[], currentCount = 0): string | null {
  if (currentCount + files.length > MAX_CHAT_IMAGES_PER_TURN) {
    return `You can attach up to ${MAX_CHAT_IMAGES_PER_TURN} images per message.`;
  }
  for (const file of files) {
    if (!ACCEPTED_CHAT_IMAGE_TYPES.includes(file.type as (typeof ACCEPTED_CHAT_IMAGE_TYPES)[number])) {
      return `${file.name || "This file"} is not a supported image. Choose a PNG, JPEG, WebP, or GIF.`;
    }
    if (file.size > MAX_CHAT_IMAGE_BYTES) return `${file.name || "This image"} is larger than 10 MB.`;
  }
  return null;
}

async function readError(response: Response): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : `Image upload failed (${response.status}).`;
}

export async function uploadChatImages(input: {
  conversationId: string;
  userMessageId: string;
  jobId: string;
  images: readonly Pick<PendingChatImage, "id" | "file">[];
  accessToken: string | Promise<string>;
  signal: AbortSignal;
}): Promise<UploadedChatImage[]> {
  const formData = new FormData();
  formData.set("conversationId", input.conversationId);
  formData.set("userMessageId", input.userMessageId);
  formData.set("jobId", input.jobId);
  for (const image of input.images) {
    formData.append("imageIds", image.id);
    formData.append("images", image.file, image.file.name);
  }
  const response = await fetch("/api/chat/images", {
    method: "POST",
    headers: { authorization: `Bearer ${await input.accessToken}` },
    body: formData,
    signal: input.signal,
  });
  if (!response.ok) throw new Error(await readError(response));
  const body = await response.json() as { attachments?: UploadedChatImage[] };
  if (!Array.isArray(body.attachments) || body.attachments.length !== input.images.length) {
    throw new Error("The uploaded images could not be prepared for chat.");
  }
  const failed = body.attachments.find(({ analysis }) => analysis.status !== "complete");
  if (failed) throw new Error(failed.analysis.error || "An image could not be analyzed. Remove it or try again.");
  return body.attachments;
}
