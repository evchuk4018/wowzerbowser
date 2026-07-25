import type { ChatLiveStreamEnvelope } from "../../lib/chat-protocol";
import { parseChatLiveEnvelope } from "./parse-chat-live-envelope";

export async function* readChatLiveStream(
  response: Response,
): AsyncGenerator<ChatLiveStreamEnvelope> {
  if (!response.body) throw new Error("The chat stream returned an empty response.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const readBlock = (block: string): ChatLiveStreamEnvelope | null => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    return data ? parseChatLiveEnvelope(data) : null;
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const envelope = readBlock(block);
      if (envelope) yield envelope;
    }
    if (done) break;
  }
  if (buffer.trim()) {
    const envelope = readBlock(buffer);
    if (envelope) yield envelope;
  }
}
