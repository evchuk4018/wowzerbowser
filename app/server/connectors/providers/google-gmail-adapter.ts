import "server-only";

export class GoogleGmailAuthorizationError extends Error {}

type GmailHeader = { name?: string; value?: string };
type GmailMessage = { id?: string; threadId?: string; labelIds?: string[]; internalDate?: string; snippet?: string; payload?: GmailPayload; sizeEstimate?: number; historyId?: string };
type GmailPayload = { mimeType?: string; filename?: string; headers?: GmailHeader[]; body?: { data?: string; size?: number }; parts?: GmailPayload[] };

type GmailApiDenialReason = "SERVICE_DISABLED" | "ACCESS_TOKEN_SCOPE_INSUFFICIENT";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function normalizedGoogleReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return normalized || null;
}

function gmailApiDenialReason(value: unknown): GmailApiDenialReason | null {
  const error = record(record(value)?.error);
  if (!error) return null;
  const reasons = [
    error.status,
    ...(Array.isArray(error.errors) ? error.errors.map((item) => record(item)?.reason) : []),
    ...(Array.isArray(error.details) ? error.details.map((item) => record(item)?.reason) : []),
  ].map(normalizedGoogleReason);
  if (reasons.some((reason) => reason === "SERVICE_DISABLED" || reason === "ACCESS_NOT_CONFIGURED")) return "SERVICE_DISABLED";
  if (reasons.some((reason) => reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT" || reason === "INSUFFICIENT_PERMISSIONS")) return "ACCESS_TOKEN_SCOPE_INSUFFICIENT";
  return null;
}

function gmailApiDeniedMessage(value: unknown): string {
  const reason = gmailApiDenialReason(value);
  if (reason === "SERVICE_DISABLED") {
    return "Gmail API access was denied (SERVICE_DISABLED). Enable the Gmail API (gmail.googleapis.com) for the OAuth project, then reconnect Gmail.";
  }
  if (reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT") {
    return "Gmail API access was denied (ACCESS_TOKEN_SCOPE_INSUFFICIENT). Reconnect Gmail and approve the Gmail read-only permission.";
  }
  return "Gmail API access was denied. Verify that the Gmail API is enabled and that the account granted the Gmail read-only permission, then reconnect Gmail.";
}

function googleErrorMessage(value: unknown): string | null {
  const message = record(record(value)?.error)?.message;
  return typeof message === "string" && message.trim() ? message : null;
}

export type GmailMessageSummary = {
  id: string;
  threadId: string | null;
  internalDate: string | null;
  snippet: string | null;
  labels: string[];
  from: string | null;
  to: string | null;
  subject: string | null;
};

export type GmailMessageRead = GmailMessageSummary & { body: string; attachments: Array<{ filename: string; mimeType: string | null; size: number }> };

function header(message: GmailMessage, name: string): string | null {
  return message.payload?.headers?.find((item) => item.name?.toLocaleLowerCase() === name.toLocaleLowerCase())?.value ?? null;
}

function decodeBody(data: string | undefined): string {
  if (!data) return "";
  try { return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"); } catch { return ""; }
}

function bodyAndAttachments(payload: GmailPayload | undefined): { body: string; attachments: GmailMessageRead["attachments"] } {
  if (!payload) return { body: "", attachments: [] };
  const parts = payload.parts ?? [];
  const nested = parts.map(bodyAndAttachments);
  const textParts = [payload, ...parts.flatMap((part) => part.parts ?? [])].filter((part) => part.mimeType === "text/plain" && part.body?.data);
  return {
    body: textParts.map((part) => decodeBody(part.body?.data)).join("\n\n"),
    attachments: [
      ...(payload.filename ? [{ filename: payload.filename, mimeType: payload.mimeType ?? null, size: payload.body?.size ?? 0 }] : []),
      ...nested.flatMap((item) => item.attachments),
    ],
  };
}

function summary(message: GmailMessage): GmailMessageSummary {
  return {
    id: message.id ?? "",
    threadId: message.threadId ?? null,
    internalDate: message.internalDate ? new Date(Number(message.internalDate)).toISOString() : null,
    snippet: message.snippet ?? null,
    labels: message.labelIds ?? [],
    from: header(message, "From"),
    to: header(message, "To"),
    subject: header(message, "Subject"),
  };
}

function read(message: GmailMessage): GmailMessageRead {
  return { ...summary(message), ...bodyAndAttachments(message.payload) };
}

async function gmailRequest(accessToken: string, path: string): Promise<unknown> {
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, { headers: { authorization: `Bearer ${accessToken}` } });
  const value = await response.json().catch(() => ({})) as unknown;
  if (response.status === 401) throw new GoogleGmailAuthorizationError("Gmail must be reconnected.");
  if (response.status === 403) throw new Error(gmailApiDeniedMessage(value));
  if (!response.ok) throw new Error(googleErrorMessage(value) ?? "Gmail request failed.");
  return value;
}

export async function gmailProfile(accessToken: string): Promise<{ emailAddress: string | null }> {
  const value = await gmailRequest(accessToken, "/profile") as { emailAddress?: string };
  return { emailAddress: value.emailAddress ?? null };
}

export async function gmailSearch(accessToken: string, input: { query: string; maxResults?: number; pageToken?: string; includeSpamTrash?: boolean; tags?: string[] }): Promise<{ messages: GmailMessageSummary[]; nextPageToken: string | null; resultSizeEstimate: number | null }> {
  const params = new URLSearchParams({ q: input.query, maxResults: String(input.maxResults ?? 20) });
  if (input.pageToken) params.set("pageToken", input.pageToken);
  if (input.includeSpamTrash !== undefined) params.set("includeSpamTrash", String(input.includeSpamTrash));
  for (const tag of input.tags ?? []) params.append("labelIds", tag);
  const value = await gmailRequest(accessToken, `/messages?${params}`) as { messages?: Array<{ id?: string; threadId?: string }>; nextPageToken?: string; resultSizeEstimate?: number };
  const messages = await Promise.all((value.messages ?? []).map(async (item) => gmailGetMessage(accessToken, item.id ?? "", false)));
  return { messages, nextPageToken: value.nextPageToken ?? null, resultSizeEstimate: value.resultSizeEstimate ?? null };
}

export async function gmailGetMessage(accessToken: string, messageId: string, includeBody = true): Promise<GmailMessageSummary | GmailMessageRead> {
  if (!messageId) throw new Error("messageId is required.");
  const message = await gmailRequest(accessToken, `/messages/${encodeURIComponent(messageId)}?format=${includeBody ? "full" : "metadata"}`) as GmailMessage;
  return includeBody ? read(message) : summary(message);
}

export async function gmailGetThread(accessToken: string, threadId: string): Promise<{ id: string; messages: GmailMessageRead[] }> {
  if (!threadId) throw new Error("threadId is required.");
  const value = await gmailRequest(accessToken, `/threads/${encodeURIComponent(threadId)}?format=full`) as { id?: string; messages?: GmailMessage[] };
  return { id: value.id ?? threadId, messages: (value.messages ?? []).map(read) };
}

export async function gmailReadThread(accessToken: string, id: string, idType: "message" | "thread" = "message") {
  if (idType === "thread") return gmailGetThread(accessToken, id);
  const message = await gmailGetMessage(accessToken, id, false) as GmailMessageSummary;
  return gmailGetThread(accessToken, message.threadId ?? id);
}

export async function gmailBatchRead(accessToken: string, messageIds: string[]): Promise<GmailMessageRead[]> {
  if (!messageIds.length) throw new Error("messageIds must contain at least one message ID.");
  if (messageIds.length > 25) throw new Error("messageIds may contain at most 25 IDs.");
  return Promise.all(messageIds.map((id) => gmailGetMessage(accessToken, id, true) as Promise<GmailMessageRead>));
}
