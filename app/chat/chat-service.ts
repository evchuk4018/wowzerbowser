import type {
  ChatArtifact,
  ChatModelInfo,
  ChatRequest,
  ChatStreamEvent,
} from "../../lib/chat-protocol";

function parseStreamBlock(block: string): ChatStreamEvent | null {
  let eventName = "message";
  const data: string[] = [];

  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trim());
  }

  if (!data.length) return null;
  try {
    const parsed = JSON.parse(data.join("\n")) as ChatStreamEvent;
    return parsed && parsed.type === eventName ? parsed : null;
  } catch {
    return null;
  }
}

async function readError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : `Request failed (${response.status}).`;
}

export async function fetchChatModels(accessToken: string): Promise<ChatModelInfo[]> {
  const response = await fetch("/api/chat/models", {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(await readError(response));

  const body = (await response.json()) as { models?: ChatModelInfo[] };
  return body.models ?? [];
}

export async function* streamChatResponse(
  request: ChatRequest,
  accessToken: string,
  signal?: AbortSignal,
): AsyncGenerator<ChatStreamEvent> {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(request),
    signal,
  });
  if (!response.ok) throw new Error(await readError(response));
  if (!response.body) throw new Error("The chat stream was empty.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? "";

    for (const block of blocks) {
      const event = parseStreamBlock(block);
      if (event) yield event;
    }

    if (done) break;
  }

  if (buffer.trim()) {
    const event = parseStreamBlock(buffer);
    if (event) yield event;
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
