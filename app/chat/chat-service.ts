import type {
  ChatArtifact,
  ChatModelInfo,
  ChatRequest,
  ChatJobResumeResponse,
  ChatStreamMetrics,
  SequencedChatStreamEvent,
} from "../../lib/chat-protocol";
import type { ChatConversation, ChatConversationSummary } from "../../lib/chat-history";
import {
  parseChatBootstrapPayload,
  type ChatBootstrapPayload,
} from "../../lib/chat-bootstrap";
import { readChatLiveStream } from "./read-chat-live-stream";
import { chatTerminalEvents } from "./chat-terminal-events";
import { waitForChatRetry } from "./chat-retry-backoff";
import { authFetch } from "../auth/auth-fetch";
import type { WorkspaceFile, WorkspaceSearchMatch } from "../../lib/workspace-protocol";

async function readError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : `Request failed (${response.status}).`;
}

export class ChatRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ChatRequestError";
  }
}

export async function fetchChatBootstrap(
  requestedConversationId?: string,
): Promise<ChatBootstrapPayload> {
  const query = requestedConversationId
    ? `?conversationId=${encodeURIComponent(requestedConversationId)}`
    : "";
  const response = await authFetch(`/api/chat/bootstrap${query}`);
  if (!response.ok) throw new ChatRequestError(response.status, await readError(response));
  return parseChatBootstrapPayload(await response.json());
}

export async function fetchChatConversations(): Promise<ChatConversationSummary[]> {
  const response = await authFetch("/api/chat/conversations");
  if (!response.ok) throw new Error(await readError(response));
  const body = await response.json() as { conversations?: ChatConversationSummary[] };
  return body.conversations ?? [];
}

export async function fetchChatConversation(conversationId: string): Promise<ChatConversation> {
  const response = await authFetch(`/api/chat/conversations/${encodeURIComponent(conversationId)}`);
  if (!response.ok) throw new Error(await readError(response));
  const body = await response.json() as { conversation?: ChatConversation };
  if (!body.conversation) throw new Error("Conversation not found.");
  return body.conversation;
}

export async function updateChatConversation(
  conversationId: string,
  values: { title?: string; turnId?: string; versionId?: string },
): Promise<void> {
  const response = await authFetch(`/api/chat/conversations/${encodeURIComponent(conversationId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(values),
  });
  if (!response.ok) throw new Error(await readError(response));
}

export async function deleteChatConversation(conversationId: string): Promise<void> {
  const response = await authFetch(`/api/chat/conversations/${encodeURIComponent(conversationId)}`, {
    method: "DELETE",
  });
  if (!response.ok) throw new Error(await readError(response));
}

export async function fetchChatModels(): Promise<ChatModelInfo[]> {
  const response = await authFetch("/api/chat/models");
  if (!response.ok) throw new Error(await readError(response));

  const body = (await response.json()) as { models?: ChatModelInfo[] };
  return body.models ?? [];
}

async function openChatStream(request: ChatRequest, signal?: AbortSignal): Promise<Response> {
  const response = await authFetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });
  if (!response.ok) throw new Error(await readError(response));
  return response;
}

export async function fetchChatJob(conversationId: string, jobId: string, after: number, signal?: AbortSignal): Promise<ChatJobResumeResponse> {
  const response = await authFetch(`/api/chat/jobs/${encodeURIComponent(conversationId)}/${encodeURIComponent(jobId)}?after=${after}`, { signal });
  if (!response.ok) throw new Error(await readError(response));
  return response.json() as Promise<ChatJobResumeResponse>;
}

/** Polls only the durable snapshot so late title/summary/analysis usage can
 * refresh a completed prompt without holding up the answer stream. */
export async function watchChatJobCost(
  conversationId: string,
  jobId: string,
  onMetrics: (metrics: ChatStreamMetrics) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (typeof window === "undefined") return;
  const timeout = AbortSignal.timeout(15_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  for (let attempt = 0; attempt < 20 && !combined.aborted; attempt += 1) {
    if (attempt > 0) await new Promise<void>((resolve) => window.setTimeout(resolve, 750));
    if (combined.aborted) return;
    try {
      const snapshot = await fetchChatJob(conversationId, jobId, Number.MAX_SAFE_INTEGER, combined);
      if (snapshot.providerMetrics) onMetrics(snapshot.providerMetrics);
    } catch {
      if (combined.aborted) return;
    }
  }
}

export async function cancelChatJob(conversationId: string, jobId: string) {
  const response = await authFetch(`/api/chat/jobs/${encodeURIComponent(conversationId)}/${encodeURIComponent(jobId)}/cancel`, { method: "POST" });
  if (!response.ok) throw new Error(await readError(response));
}

async function workspaceError(response: Response): Promise<Error> {
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  return new Error(typeof body?.error === "string" ? body.error : `Workspace request failed (${response.status}).`);
}

export async function fetchWorkspaceFiles(conversationId: string, path = ""): Promise<WorkspaceFile[]> {
  const query = path ? `?path=${encodeURIComponent(path)}` : "";
  const response = await authFetch(`/api/chat/workspace/${encodeURIComponent(conversationId)}${query}`);
  if (!response.ok) throw await workspaceError(response);
  const body = await response.json() as { files?: WorkspaceFile[] };
  return body.files ?? [];
}

export async function readWorkspaceFileContent(conversationId: string, path: string): Promise<{ file: WorkspaceFile; content: string }> {
  const response = await authFetch(`/api/chat/workspace/${encodeURIComponent(conversationId)}/read`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!response.ok) throw await workspaceError(response);
  return response.json() as Promise<{ file: WorkspaceFile; content: string }>;
}

export async function searchWorkspace(conversationId: string, query: string, path = ""): Promise<WorkspaceSearchMatch[]> {
  const response = await authFetch(`/api/chat/workspace/${encodeURIComponent(conversationId)}/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, path }),
  });
  if (!response.ok) throw await workspaceError(response);
  const body = await response.json() as { matches?: WorkspaceSearchMatch[] };
  return body.matches ?? [];
}

export async function saveWorkspaceFile(conversationId: string, path: string, content: string, expectedSha256?: string): Promise<{ file: WorkspaceFile; content: string }> {
  const response = await authFetch(`/api/chat/workspace/${encodeURIComponent(conversationId)}/file`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, content, expectedSha256 }),
  });
  if (!response.ok) throw await workspaceError(response);
  return response.json() as Promise<{ file: WorkspaceFile; content: string }>;
}

export async function deleteWorkspaceFile(conversationId: string, path: string): Promise<void> {
  const response = await authFetch(`/api/chat/workspace/${encodeURIComponent(conversationId)}/file`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!response.ok) throw await workspaceError(response);
}

export async function resumeChatJob(conversationId: string, jobId: string): Promise<void> {
  const response = await authFetch(`/api/chat/jobs/${encodeURIComponent(conversationId)}/${encodeURIComponent(jobId)}/resume`, {
    method: "POST",
  });
  if (!response.ok) throw new Error(await readError(response));
}

export async function* streamChatResponse(
  request: ChatRequest,
  signal?: AbortSignal,
): AsyncGenerator<SequencedChatStreamEvent> {
  let sequence = 0;
  let streamCompleted = false;
  let sawStreamError = false;
  let sawDone = false;
  let activeJobId = request.jobId!;
  const response = await openChatStream(request, signal);
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
          providerMetrics: terminal.providerMetrics,
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

  let retryAttempt = 0;
  const retrySignal = signal ?? new AbortController().signal;
  while (!signal?.aborted) {
    try {
      await resumeChatJob(request.conversationId!, activeJobId);
    } catch {
      if (signal?.aborted) throw signal.reason;
      if (!(await waitForChatRetry(retrySignal, retryAttempt++))) return;
      continue;
    }
    let snapshot: ChatJobResumeResponse;
    try {
      snapshot = await fetchChatJob(request.conversationId!, activeJobId, sequence, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (!(await waitForChatRetry(retrySignal, retryAttempt++))) return;
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
        providerMetrics: snapshot.providerMetrics,
        after: sequence,
        sawError: sawStreamError,
        sawDone,
      })) {
        sequence = event.sequence;
        yield event;
      }
      return;
    }
    if (!(await waitForChatRetry(retrySignal, retryAttempt++))) return;
  }
}

export async function fetchChatArtifact(
  artifact: ChatArtifact,
): Promise<Blob> {
  const response = await authFetch(
    `/api/chat/artifacts/${encodeURIComponent(artifact.id)}`,
  );
  if (!response.ok) throw new Error(await readError(response));
  return response.blob();
}

export async function fetchChatImage(
  imageId: string,
  conversationId: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const response = await authFetch(
    `/api/chat/images/${encodeURIComponent(imageId)}?conversationId=${encodeURIComponent(conversationId)}`,
    { signal },
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
