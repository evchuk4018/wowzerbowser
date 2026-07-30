import "server-only";

import {
  DISCORD_MAX_ATTACHMENT_BYTES,
  type DiscordInboundAttachment,
} from "../../../lib/discord-protocol";

const ALLOWED_DOCUMENT_TYPES = new Map([
  ["application/pdf", "application/pdf"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
]);
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export type DownloadedDiscordAttachment = {
  id: string;
  filename: string;
  contentType: string;
  bytes: Uint8Array;
  kind: "image" | "document";
};

function inferredContentType(filename: string): string | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return null;
}

export async function downloadDiscordAttachment(
  attachment: DiscordInboundAttachment,
  signal?: AbortSignal,
): Promise<DownloadedDiscordAttachment> {
  const contentType = attachment.contentType?.split(";")[0]?.trim() || inferredContentType(attachment.filename);
  if (!contentType || (!IMAGE_TYPES.has(contentType) && !ALLOWED_DOCUMENT_TYPES.has(contentType))) {
    throw new Error(`Unsupported Discord attachment type for ${attachment.filename}.`);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch(attachment.url, {
      signal: controller.signal,
      redirect: "error",
      headers: { "user-agent": "WowzerBowser-Discord/1.0" },
    });
    if (!response.ok) throw new Error(`Discord attachment download failed (${response.status}).`);
    const declaredLength = Number(response.headers.get("content-length") ?? attachment.size);
    if (!Number.isFinite(declaredLength) || declaredLength > DISCORD_MAX_ATTACHMENT_BYTES) {
      throw new Error("Discord attachment exceeds 25 MiB.");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > DISCORD_MAX_ATTACHMENT_BYTES || bytes.length !== attachment.size) {
      throw new Error("Discord attachment size did not match its metadata.");
    }
    return {
      id: crypto.randomUUID(),
      filename: attachment.filename,
      contentType,
      bytes,
      kind: IMAGE_TYPES.has(contentType) ? "image" : "document",
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}
