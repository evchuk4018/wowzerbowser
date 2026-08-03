"use client";

import {
  CHAT_IMAGE_CONTENT_TYPES,
  CHAT_IMAGE_MAX_BYTES,
  CHAT_IMAGE_MAX_COUNT,
  type ChatImageAttachment,
} from "../../lib/chat-protocol";
import { authFetch } from "../auth/auth-fetch";

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

function waitFor(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new Error("Image preparation was cancelled."));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

async function waitForImageJob(input: { conversationId: string; jobId: string; signal: AbortSignal }): Promise<UploadedChatImage> {
  let delay = 250;
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const response = await authFetch(`/api/chat/images/jobs/${encodeURIComponent(input.conversationId)}/${encodeURIComponent(input.jobId)}`, { signal: input.signal });
    if (!response.ok) throw new Error(await readError(response));
    const snapshot = await response.json() as { status: string; error?: string | null; attachment?: UploadedChatImage };
    if (snapshot.status === "completed" && snapshot.attachment) return snapshot.attachment;
    if (snapshot.status === "failed" || snapshot.status === "cancelled") {
      throw new Error(snapshot.error ?? "An image could not be prepared. Remove it or try again.");
    }
    await waitFor(delay, input.signal);
    delay = Math.min(2_000, Math.round(delay * 1.5));
  }
  throw new Error("Image preparation timed out. Please retry the image.");
}

export async function uploadChatImages(input: {
  conversationId: string;
  userMessageId: string;
  jobId: string;
  images: readonly Pick<PendingChatImage, "id" | "file">[];
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
  const response = await authFetch("/api/chat/images", {
    method: "POST",
    body: formData,
    signal: input.signal,
  });
  if (!response.ok) throw new Error(await readError(response));
  const body = await response.json() as {
    attachments?: UploadedChatImage[];
    jobs?: Array<{ imageId: string; processingJobId: string | null; status: string; attachment?: UploadedChatImage | null; error?: string | null }>;
  };
  if (Array.isArray(body.jobs)) {
    const uploaded = await Promise.all(body.jobs.map((job) => job.attachment
      ? Promise.resolve(job.attachment)
      : job.processingJobId
        ? waitForImageJob({ conversationId: input.conversationId, jobId: job.processingJobId, signal: input.signal })
        : Promise.reject(new Error(job.error ?? "The uploaded image could not be prepared."))));
    if (uploaded.length !== input.images.length) throw new Error("The uploaded images could not be prepared for chat.");
    return uploaded;
  }
  if (!Array.isArray(body.attachments) || body.attachments.length !== input.images.length) throw new Error("The uploaded images could not be prepared for chat.");
  const failed = body.attachments.find(({ analysis }) => analysis.status !== "complete");
  if (failed) throw new Error(failed.analysis.error || "An image could not be analyzed. Remove it or try again.");
  return body.attachments;
}
