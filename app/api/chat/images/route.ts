import { after } from "next/server";
import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../auth/owner-auth-service";
import {
  MAX_CHAT_IMAGES_PER_TURN,
  MAX_CHAT_IMAGE_BYTES,
  MAX_CHAT_IMAGE_REQUEST_BYTES,
  ChatImageError,
  isValidChatImageId,
} from "../../../../lib/chat-image";
import { analyzeAndStoreChatImages, type ChatImageUpload } from "../../../server/chat/chat-image-service";
import { cleanupExpiredChatImageUploads } from "../../../server/chat/chat-image-store";

export const runtime = "nodejs";
export const maxDuration = 180;

const MULTIPART_CONTENT_TYPE = /^multipart\/form-data(?:\s*;|$)/i;

export function validateMultipartContentType(value: string | null): string {
  if (!value || !MULTIPART_CONTENT_TYPE.test(value)) {
    throw new ChatImageError("invalid_multipart", "Image uploads must use multipart/form-data.");
  }
  return value;
}

function requestTooLarge(): ChatImageError {
  return new ChatImageError("request_too_large", "The image upload request is too large.", 413);
}

function validateContentLength(value: string | null): void {
  if (value === null) return;
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new ChatImageError("invalid_content_length", "The image upload request is invalid.");
  }
  const length = Number(normalized);
  if (!Number.isSafeInteger(length) || length > MAX_CHAT_IMAGE_REQUEST_BYTES) {
    throw requestTooLarge();
  }
}

export async function readBoundedRequestBody(request: Request): Promise<Uint8Array> {
  validateContentLength(request.headers.get("content-length"));
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = result.value;
      size += chunk.byteLength;
      if (size > MAX_CHAT_IMAGE_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw requestTooLarge();
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function parseBoundedMultipartForm(request: Request): Promise<FormData> {
  const contentType = validateMultipartContentType(request.headers.get("content-type"));
  let body: Uint8Array;
  try {
    body = await readBoundedRequestBody(request);
  } catch (error) {
    if (error instanceof ChatImageError) throw error;
    throw new ChatImageError("invalid_multipart", "The image upload form is invalid.");
  }
  try {
    return await new Request(request.url, {
      method: "POST",
      headers: { "content-type": contentType },
      body: Buffer.from(body),
    }).formData();
  } catch (error) {
    if (error instanceof ChatImageError) throw error;
    throw new ChatImageError("invalid_multipart", "The image upload form is invalid.");
  }
}

export function hasDuplicateImageIds(ids: unknown[]): boolean {
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string") continue;
    if (seen.has(id)) return true;
    seen.add(id);
  }
  return false;
}

export function createChatImageUploadHandler(dependencies = {
  authorizeOwnerSession,
  analyzeAndStoreChatImages,
  cleanupExpiredChatImageUploads,
}) {
  return async function POST(request: Request) {
    const authorization = request.headers.get("authorization");
    const owner = authorization?.startsWith("Bearer ")
      ? await dependencies.authorizeOwnerSession(authorization.slice(7))
      : null;
    if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    try {
      const form = await parseBoundedMultipartForm(request);
      const conversationId = form.get("conversationId");
      const userMessageId = form.get("userMessageId");
      const jobId = form.get("jobId");
      const ids = form.getAll("imageIds");
      const files = form.getAll("images");
      if (!isValidChatImageId(conversationId) || !isValidChatImageId(userMessageId) || !isValidChatImageId(jobId)) {
        return NextResponse.json({ error: "Invalid image upload identifiers." }, { status: 400 });
      }
      if (files.length < 1 || files.length !== ids.length || files.length > MAX_CHAT_IMAGES_PER_TURN) {
        return NextResponse.json({ error: `Attach between 1 and ${MAX_CHAT_IMAGES_PER_TURN} images.` }, { status: 400 });
      }
      if (hasDuplicateImageIds(ids)) {
        return NextResponse.json({ error: "Image IDs must be unique." }, { status: 400 });
      }
      const uploads: ChatImageUpload[] = [];
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        const id = ids[index];
        if (!(file instanceof File) || !isValidChatImageId(id)) {
          return NextResponse.json({ error: "Invalid image upload." }, { status: 400 });
        }
        if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_CHAT_IMAGE_BYTES) {
          return NextResponse.json({ error: "Each image must be 10 MB or smaller." }, { status: 413 });
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (bytes.byteLength > MAX_CHAT_IMAGE_BYTES) {
          return NextResponse.json({ error: "Each image must be 10 MB or smaller." }, { status: 413 });
        }
        uploads.push({
          id,
          name: file.name || null,
          declaredType: file.type || null,
          bytes,
        });
      }
      const attachments = await dependencies.analyzeAndStoreChatImages(owner.id, conversationId, userMessageId, uploads, { jobId });
      if (dependencies.cleanupExpiredChatImageUploads) {
        after(() => dependencies.cleanupExpiredChatImageUploads?.(owner.id, conversationId)?.catch(() => undefined));
      }
      return NextResponse.json({ attachments });
    } catch (error) {
      if (error instanceof ChatImageError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      return NextResponse.json({ error: "The images could not be prepared for chat." }, { status: 503 });
    }
  };
}

export const POST = createChatImageUploadHandler();
