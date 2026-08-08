import "server-only";

export class GoogleGmailAuthorizationError extends Error {}

type GmailHeader = { name?: string; value?: string };
type GmailMessage = { id?: string; threadId?: string; labelIds?: string[]; internalDate?: string; snippet?: string; payload?: GmailPayload; sizeEstimate?: number; historyId?: string };
type GmailPayload = { mimeType?: string; filename?: string; headers?: GmailHeader[]; body?: { data?: string; size?: number }; parts?: GmailPayload[] };

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
  if (response.status === 401 || response.status === 403) throw new GoogleGmailAuthorizationError("Gmail must be reconnected.");
  const value = await response.json().catch(() => ({})) as { error?: { message?: string } };
  if (!response.ok) throw new Error(value.error?.message ?? "Gmail request failed.");
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
