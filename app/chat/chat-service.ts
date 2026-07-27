import type {
  ChatArtifact,
  ChatModelInfo,
  ChatRequest,
  ChatJobResumeResponse,
  SequencedChatStreamEvent,
} from "../../lib/chat-protocol";
import type { ChatConversation, ChatConversationSummary } from "../../lib/chat-history";
import { readChatLiveStream } from "./read-chat-live-stream";
import { chatTerminalEvents } from "./chat-terminal-events";

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

async function openChatStream(request: ChatRequest, accessToken: string, signal?: AbortSignal): Promise<Response> {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });
  if (!response.ok) throw new Error(await readError(response));
  return response;
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
  let sequence = 0;
  let streamCompleted = false;
  let sawStreamError = false;
  let sawDone = false;
  let activeJobId = request.jobId!;
  const response = await openChatStream(request, accessToken, signal);
  try {
    for await (const envelope of readChatLiveStream(response)) {
      if (envelope.type === "submission") {
        activeJobId = envelope.submission.jobId;
      } else if (envelope.type === "event") {
        if (envelope.event.sequence <= sequence) continue;
        sequence = envelope.event.sequence;
        if (envelope.event.type === "error") sawStreamError = true;
        if (envelope.event.type === "done") sawDone = true;
        yield envelope.event;
      } else if (envelope.type === "terminal") {
        const { terminal } = envelope;
        for (const event of chatTerminalEvents({
          jobId: terminal.jobId,
          status: terminal.status,
          error: terminal.error,
          usage: terminal.usage,
          after: sequence,
          sawError: sawStreamError,
          sawDone,
        })) {
          sequence = event.sequence;
          yield event;
        }
        streamCompleted = true;
      }
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    // The job is durable. Resume below from the last live event after a
    // transport interruption.
  }
  if (streamCompleted || signal?.aborted) return;

  while (!signal?.aborted) {
    let snapshot: ChatJobResumeResponse;
    try {
      snapshot = await fetchChatJob(request.conversationId!, activeJobId, sequence, accessToken, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue; // transient network loss: replay resumes strictly after sequence
    }
    for (const event of snapshot.events) {
      if (event.sequence <= sequence) continue;
      sequence = event.sequence;
      if (event.type === "error") sawStreamError = true;
      if (event.type === "done") sawDone = true;
      yield event;
    }
    if (snapshot.hasMore) continue;
    if (["completed", "failed", "cancelled"].includes(snapshot.status)) {
      for (const event of chatTerminalEvents({
        jobId: snapshot.jobId,
        status: snapshot.status,
        error: snapshot.error,
        usage: snapshot.usage,
        after: sequence,
        sawError: sawStreamError,
        sawDone,
      })) {
        sequence = event.sequence;
        yield event;
      }
      return;
    }
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

export async function fetchChatImage(
  imageId: string,
  conversationId: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const response = await fetch(
    `/api/chat/images/${encodeURIComponent(imageId)}?conversationId=${encodeURIComponent(conversationId)}`,
    { headers: { authorization: `Bearer ${accessToken}` }, signal },
  );
  if (!response.ok) throw new ChatImageFetchError(response.status, await readError(response));
  return response.blob();
}

export class ChatImageFetchError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ChatImageFetchError";
  }
}
