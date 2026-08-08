import "server-only";

export class MicrosoftOutlookAuthorizationError extends Error {}

type OutlookEmailAddress = { emailAddress?: { name?: string; address?: string } };
type OutlookBody = { content?: string; contentType?: string };
type OutlookAttachment = { id?: string; name?: string; contentType?: string; size?: number; isInline?: boolean };
type OutlookMessage = {
  id?: string;
  conversationId?: string;
  receivedDateTime?: string;
  sentDateTime?: string;
  bodyPreview?: string;
  subject?: string;
  from?: OutlookEmailAddress;
  toRecipients?: OutlookEmailAddress[];
  ccRecipients?: OutlookEmailAddress[];
  body?: OutlookBody;
  hasAttachments?: boolean;
  isRead?: boolean;
  importance?: string;
  attachments?: OutlookAttachment[];
};

type GraphCollection<T> = { value?: T[]; "@odata.nextLink"?: string };

export type OutlookMessageSummary = {
  id: string;
  conversationId: string | null;
  receivedDateTime: string | null;
  sentDateTime: string | null;
  bodyPreview: string | null;
  from: string | null;
  to: string[];
  cc: string[];
  subject: string | null;
  hasAttachments: boolean;
  isRead: boolean | null;
  importance: string | null;
};

export type OutlookMessageRead = OutlookMessageSummary & {
  body: string;
  bodyContentType: string | null;
  attachments: Array<{ id: string | null; filename: string; mimeType: string | null; size: number; isInline: boolean }>;
};

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
const GRAPH_ORIGIN = "https://graph.microsoft.com";

function recipient(value: OutlookEmailAddress | undefined): string | null {
  const address = value?.emailAddress?.address?.trim();
  const name = value?.emailAddress?.name?.trim();
  if (!address) return name || null;
  return name ? `${name} <${address}>` : address;
}

function recipients(values: OutlookEmailAddress[] | undefined): string[] {
  return (values ?? []).map(recipient).filter((value): value is string => Boolean(value));
}

function summary(message: OutlookMessage): OutlookMessageSummary {
  return {
    id: message.id ?? "",
    conversationId: message.conversationId ?? null,
    receivedDateTime: message.receivedDateTime ?? null,
    sentDateTime: message.sentDateTime ?? null,
    bodyPreview: message.bodyPreview ?? null,
    from: recipient(message.from),
    to: recipients(message.toRecipients),
    cc: recipients(message.ccRecipients),
    subject: message.subject ?? null,
    hasAttachments: message.hasAttachments === true,
    isRead: typeof message.isRead === "boolean" ? message.isRead : null,
    importance: message.importance ?? null,
  };
}

function read(message: OutlookMessage): OutlookMessageRead {
  return {
    ...summary(message),
    body: message.body?.content ?? "",
    bodyContentType: message.body?.contentType ?? null,
    attachments: (message.attachments ?? []).map((attachment) => ({
      id: attachment.id ?? null,
      filename: attachment.name ?? "attachment",
      mimeType: attachment.contentType ?? null,
      size: typeof attachment.size === "number" ? attachment.size : 0,
      isInline: attachment.isInline === true,
    })),
  };
}

function graphUrl(target: string): URL {
  const url = target.startsWith("http") ? new URL(target) : new URL(`${GRAPH_BASE_URL}${target.startsWith("/") ? target : `/${target}`}`);
  if (url.origin !== GRAPH_ORIGIN || !url.pathname.startsWith("/v1.0/")) throw new Error("Invalid Microsoft Graph page token.");
  return url;
}

async function graphRequest(accessToken: string, target: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(graphUrl(target), {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
      prefer: 'outlook.body-content-type="text"',
    },
    signal,
  });
  if (response.status === 401 || response.status === 403) throw new MicrosoftOutlookAuthorizationError("Outlook must be reconnected.");
  const value = await response.json().catch(() => ({})) as { error?: { message?: string } };
  if (!response.ok) throw new Error(value.error?.message ?? "Microsoft Graph request failed.");
  return value;
}

export async function outlookProfile(accessToken: string, signal?: AbortSignal): Promise<{ displayName: string | null; emailAddress: string | null }> {
  const value = await graphRequest(accessToken, "/me?$select=displayName,mail,userPrincipalName", signal) as { displayName?: string; mail?: string; userPrincipalName?: string };
  return { displayName: value.displayName ?? null, emailAddress: value.mail ?? value.userPrincipalName ?? null };
}

function pageSize(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(Math.max(Math.floor(value), 1), 100) : 20;
}

function searchExpression(query: string): string {
  return `"${query.trim().replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export async function outlookSearch(accessToken: string, input: { query: string; maxResults?: number; pageToken?: string }, signal?: AbortSignal): Promise<{ messages: OutlookMessageSummary[]; nextPageToken: string | null; resultSizeEstimate: number | null }> {
  if (!input.query?.trim() && !input.pageToken) throw new Error("query is required.");
  let target = input.pageToken?.trim();
  if (!target) {
    const params = new URLSearchParams({
      "$select": "id,conversationId,receivedDateTime,sentDateTime,bodyPreview,subject,from,toRecipients,ccRecipients,hasAttachments,isRead,importance",
      "$top": String(pageSize(input.maxResults)),
      "$search": searchExpression(input.query),
    });
    target = `/me/messages?${params}`;
  }
  const value = await graphRequest(accessToken, target, signal) as GraphCollection<OutlookMessage>;
  return { messages: (value.value ?? []).map(summary), nextPageToken: value["@odata.nextLink"] ?? null, resultSizeEstimate: null };
}

export async function outlookGetMessage(accessToken: string, messageId: string, signal?: AbortSignal): Promise<OutlookMessageRead> {
  if (!messageId) throw new Error("messageId is required.");
  const params = new URLSearchParams({
    "$select": "id,conversationId,receivedDateTime,sentDateTime,bodyPreview,subject,from,toRecipients,ccRecipients,body,hasAttachments,isRead,importance",
    "$expand": "attachments($select=id,name,contentType,size,isInline)",
  });
  const message = await graphRequest(accessToken, `/me/messages/${encodeURIComponent(messageId)}?${params}`, signal) as OutlookMessage;
  return read(message);
}

export async function outlookBatchRead(accessToken: string, messageIds: string[], signal?: AbortSignal): Promise<OutlookMessageRead[]> {
  if (!messageIds.length) throw new Error("messageIds must contain at least one message ID.");
  if (messageIds.length > 25) throw new Error("messageIds may contain at most 25 IDs.");
  return Promise.all(messageIds.map((id) => outlookGetMessage(accessToken, id, signal)));
}
