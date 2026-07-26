import type { ChatUsage } from "./chat-protocol";

export const CHAT_IMAGE_CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

export type ChatImageContentType = (typeof CHAT_IMAGE_CONTENT_TYPES)[number];

export const MAX_CHAT_IMAGES_PER_TURN = 4;
export const MAX_CHAT_IMAGE_BYTES = 10 * 1024 * 1024;
export const CHAT_IMAGE_UPLOAD_TIMEOUT_MS = 30_000;
export const OPENROUTER_IMAGE_TIMEOUT_MS = 60_000;
export const MAX_IMAGE_ANALYSIS_RESPONSE_LENGTH = 8_000;
export const MAX_IMAGE_FOLLOWUP_QUESTION_LENGTH = 1_000;
export const MAX_IMAGE_CONTEXT_FIELD_LENGTH = 4_000;
export const MAX_CHAT_IMAGE_REQUEST_BYTES = MAX_CHAT_IMAGES_PER_TURN * MAX_CHAT_IMAGE_BYTES + 1_000_000;
export const CHAT_IMAGE_BUCKET = "chat-images";

export type ChatImageAnalysis = {
  status: "complete" | "failed";
  visibleText: string | null;
  mainVisuals: string | null;
  textModel: string | null;
  visualModel: string | null;
  textUsage?: ChatUsage | null;
  visualUsage?: ChatUsage | null;
  error?: string;
};

export type ChatImageAttachment = {
  id: string;
  name: string | null;
  contentType: ChatImageContentType;
  size: number;
  storagePath: string;
  analysis: ChatImageAnalysis;
};

export type ChatImageToolResult = {
  kind: "image";
  imageId: string;
  question: string;
  answer: string;
  model: string | null;
};

export class ChatImageError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "ChatImageError";
    this.code = code;
    this.status = status;
  }
}

export function isValidChatImageId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
}

function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= 24
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
    && bytes.at(-8) === 0x49 && bytes.at(-7) === 0x45 && bytes.at(-6) === 0x4e && bytes.at(-5) === 0x44;
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

function isWebp(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP";
}

function isGif(bytes: Uint8Array): boolean {
  return bytes.length >= 6 && (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a");
}

export function detectChatImageContentType(bytes: Uint8Array): ChatImageContentType | null {
  if (isPng(bytes)) return "image/png";
  if (isJpeg(bytes)) return "image/jpeg";
  if (isWebp(bytes)) return "image/webp";
  if (isGif(bytes)) return "image/gif";
  return null;
}

export function validateChatImageBytes(bytes: Uint8Array, declaredType?: string): ChatImageContentType {
  if (bytes.byteLength === 0) throw new ChatImageError("empty_image", "The image is empty.");
  if (bytes.byteLength > MAX_CHAT_IMAGE_BYTES) {
    throw new ChatImageError("image_too_large", "Each image must be 10 MB or smaller.", 413);
  }
  const detected = detectChatImageContentType(bytes);
  if (!detected) throw new ChatImageError("malformed_image", "The image bytes are not a supported PNG, JPEG, WebP, or GIF.");
  if (declaredType && declaredType !== detected) {
    throw new ChatImageError("spoofed_image_type", "The image content does not match its declared type.");
  }
  return detected;
}

export function sanitizeChatImageName(name: string | null | undefined): string | null {
  if (!name) return null;
  const normalized = name.normalize("NFKC").replace(/[\\/\0\r\n]+/g, "-").replace(/[^a-zA-Z0-9._ -]/g, "").trim();
  return normalized ? normalized.slice(0, 180) : null;
}

export function imageContextForAttachment(image: ChatImageAttachment): string {
  const sanitize = (value: string | null) => (value ?? "")
    .slice(0, MAX_IMAGE_CONTEXT_FIELD_LENGTH)
    .replaceAll("[/attached_image]", "[ /attached_image ]");
  const visibleText = sanitize(image.analysis.visibleText);
  const mainVisuals = sanitize(image.analysis.mainVisuals);
  return [
    "[attached_image]",
    `image_id: ${image.id}`,
    "visible_text:",
    visibleText,
    "",
    "main_visuals:",
    mainVisuals,
    "[/attached_image]",
  ].join("\\n");
}
