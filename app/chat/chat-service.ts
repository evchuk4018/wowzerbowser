import type {
  ChatArtifact,
  ChatModelInfo,
  ChatRequest,
  ChatJobResumeResponse,
  ChatJobSubmissionResponse,
  SequencedChatStreamEvent,
} from "../../lib/chat-protocol";
import type { ChatConversation, ChatConversationSummary } from "../../lib/chat-history";

const LIVE_CHAT_POLL_INTERVAL_MS = 100;

async function readError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : `Request failed (${response.status}).`;
}

export async function fetchChatConversations(accessToken: string): Promise<ChatConversationSummary[]> {
  const response = await fetch("/api/chat/conversations", {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(await readError(response));
  const body = await response.json() as { conversations?: ChatConversationSummary[] };
  return body.conversations ?? [];
}

export async function fetchChatConversation(conversationId: string, accessToken: string): Promise<ChatConversation> {
  const response = await fetch(`/api/chat/conversations/${encodeURIComponent(conversationId)}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(await readError(response));
  const body = await response.json() as { conversation?: ChatConversation };
  if (!body.conversation) throw new Error("Conversation not found.");
  return body.conversation;
}

export async function updateChatConversation(
  conversationId: string,
  values: { title?: string; turnId?: string; versionId?: string },
  accessToken: string,
): Promise<void> {
  const response = await fetch(`/api/chat/conversations/${encodeURIComponent(conversationId)}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify(values),
  });
  if (!response.ok) throw new Error(await readError(response));
}

export async function deleteChatConversation(conversationId: string, accessToken: string): Promise<void> {
  const response = await fetch(`/api/chat/conversations/${encodeURIComponent(conversationId)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(await readError(response));
}

export async function fetchChatModels(accessToken: string): Promise<ChatModelInfo[]> {
  const response = await fetch("/api/chat/models", {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(await readError(response));

  const body = (await response.json()) as { models?: ChatModelInfo[] };
  return body.models ?? [];
}

export async function submitChatJob(request: ChatRequest, accessToken: string): Promise<ChatJobSubmissionResponse> {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!response.ok) throw new Error(await readError(response));
  return response.json() as Promise<ChatJobSubmissionResponse>;
}

export async function fetchChatJob(conversationId: string, jobId: string, after: number, accessToken: string, signal?: AbortSignal): Promise<ChatJobResumeResponse> {
  const response = await fetch(`/api/chat/jobs/${encodeURIComponent(conversationId)}/${encodeURIComponent(jobId)}?after=${after}`, { headers: { authorization: `Bearer ${accessToken}` }, signal });
  if (!response.ok) throw new Error(await readError(response));
  return response.json() as Promise<ChatJobResumeResponse>;
}

export async function cancelChatJob(conversationId: string, jobId: string, accessToken: string) {
  const response = await fetch(`/api/chat/jobs/${encodeURIComponent(conversationId)}/${encodeURIComponent(jobId)}/cancel`, { method: "POST", headers: { authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw new Error(await readError(response));
}

export async function* streamChatResponse(
  request: ChatRequest,
  accessToken: string,
  signal?: AbortSignal,
): AsyncGenerator<SequencedChatStreamEvent> {
  const submission = await submitChatJob(request, accessToken);
  let sequence = 0;
  while (!signal?.aborted) {
    let snapshot: ChatJobResumeResponse;
    try {
      snapshot = await fetchChatJob(request.conversationId!, submission.jobId, sequence, accessToken, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue; // transient network loss: replay resumes strictly after sequence
    }
    for (const event of snapshot.events) {
      if (event.sequence <= sequence) continue;
      sequence = event.sequence;
      yield event;
    }
    if (["completed", "failed", "cancelled"].includes(snapshot.status)) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, LIVE_CHAT_POLL_INTERVAL_MS);
      signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    });
  }
}

export async function fetchChatArtifact(
  artifact: ChatArtifact,
  accessToken: string,
): Promise<Blob> {
  const response = await fetch(
    `/api/chat/artifacts/${encodeURIComponent(artifact.id)}`,
    {
      headers: { authorization: `Bearer ${accessToken}` },
    },
  );
  if (!response.ok) throw new Error(await readError(response));
  return response.blob();
}
