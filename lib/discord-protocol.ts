export const DISCORD_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const DISCORD_MAX_ATTACHMENTS = 10;
export const DISCORD_MESSAGE_CONTENT_LIMIT = 2_000;

export type DiscordInboundAttachment = {
  id: string;
  filename: string;
  contentType: string | null;
  size: number;
  url: string;
};

export type DiscordInboundMessage = {
  messageId: string;
  channelId: string;
  userId: string;
  responseMessageId: string;
  content: string;
  attachments: DiscordInboundAttachment[];
};

export type DiscordSubmission = {
  messageId: string;
  channelId: string;
  responseMessageId: string;
  conversationId: string | null;
  jobId: string | null;
  status: "processing" | "running" | "completed" | "failed";
  error: string | null;
  output: string | null;
};

export type DiscordAutomationNotification = {
  id: string;
  automationRunId: string;
  conversationId: string;
  title: string;
  message: string;
  status: "delivering";
  attemptCount: number;
};

export type DiscordAutomationDeliveryResult =
  | { status: "delivered"; channelId: string; messageId: string }
  | { status: "failed"; error: string };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requiredSnowflake(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d{1,24}$/.test(value)) {
    throw new Error(`${field} is invalid.`);
  }
  return value;
}

function attachmentUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_048) throw new Error("Attachment URL is invalid.");
  const url = new URL(value);
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.port
    || !["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname.toLowerCase())
  ) {
    throw new Error("Attachment URL is invalid.");
  }
  return url.toString();
}

export function parseDiscordInboundMessage(value: unknown): DiscordInboundMessage {
  const candidate = record(value);
  if (!candidate) throw new Error("Discord message payload is invalid.");
  const content = typeof candidate.content === "string" ? candidate.content.trim() : "";
  if (content.length > 20_000) throw new Error("Discord message is too long.");
  if (!Array.isArray(candidate.attachments) || candidate.attachments.length > DISCORD_MAX_ATTACHMENTS) {
    throw new Error(`Discord messages may contain at most ${DISCORD_MAX_ATTACHMENTS} attachments.`);
  }
  const attachments = candidate.attachments.map((value) => {
    const item = record(value);
    if (!item) throw new Error("Discord attachment is invalid.");
    if (typeof item.filename !== "string" || !item.filename.trim() || item.filename.length > 255) {
      throw new Error("Discord attachment filename is invalid.");
    }
    if (!Number.isSafeInteger(item.size) || Number(item.size) < 0 || Number(item.size) > DISCORD_MAX_ATTACHMENT_BYTES) {
      throw new Error("Discord attachments must be 25 MiB or smaller.");
    }
    return {
      id: requiredSnowflake(item.id, "Attachment ID"),
      filename: item.filename.replace(/[\\/]/g, "_").slice(0, 160),
      contentType: typeof item.contentType === "string" ? item.contentType.toLowerCase().slice(0, 120) : null,
      size: Number(item.size),
      url: attachmentUrl(item.url),
    };
  });
  if (!content && !attachments.length) throw new Error("Discord message is empty.");
  return {
    messageId: requiredSnowflake(candidate.messageId, "Message ID"),
    channelId: requiredSnowflake(candidate.channelId, "Channel ID"),
    userId: requiredSnowflake(candidate.userId, "User ID"),
    responseMessageId: requiredSnowflake(candidate.responseMessageId, "Response message ID"),
    content,
    attachments,
  };
}

export function parseDiscordAutomationDeliveryResult(value: unknown): DiscordAutomationDeliveryResult {
  const candidate = record(value);
  if (!candidate || (candidate.status !== "delivered" && candidate.status !== "failed")) {
    throw new Error("Discord delivery result is invalid.");
  }
  if (candidate.status === "failed") {
    if (typeof candidate.error !== "string" || !candidate.error.trim()) throw new Error("Discord delivery error is required.");
    return { status: "failed", error: candidate.error.trim().slice(0, 2_000) };
  }
  return {
    status: "delivered",
    channelId: requiredSnowflake(candidate.channelId, "Channel ID"),
    messageId: requiredSnowflake(candidate.messageId, "Message ID"),
  };
}

export function splitDiscordMessage(content: string, link: string): string[] {
  const safeContent = content.trim() || "The assistant completed without a text response.";
  const suffix = `\n\nOpen in app: ${link}`;
  const finalLimit = DISCORD_MESSAGE_CONTENT_LIMIT - suffix.length;
  if (finalLimit < 200) throw new Error("Conversation link is too long.");
  const chunks: string[] = [];
  let remaining = safeContent;
  while (remaining.length > finalLimit) {
    const window = remaining.slice(0, DISCORD_MESSAGE_CONTENT_LIMIT);
    const boundary = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
    const end = boundary >= 1_000 ? boundary : DISCORD_MESSAGE_CONTENT_LIMIT;
    chunks.push(remaining.slice(0, end).trimEnd());
    remaining = remaining.slice(end).trimStart();
  }
  chunks.push(`${remaining}${suffix}`);
  return chunks;
}
