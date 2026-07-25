import type { ChatLiveStreamEnvelope } from "../../lib/chat-protocol";

export function parseChatLiveEnvelope(value: string): ChatLiveStreamEnvelope | null {
  try {
    const envelope = JSON.parse(value) as Partial<ChatLiveStreamEnvelope>;
    if (
      envelope.type === "submission"
      || envelope.type === "event"
      || envelope.type === "terminal"
    ) {
      return envelope as ChatLiveStreamEnvelope;
    }
  } catch {
    // Ignore malformed frames and continue reading the durable stream.
  }
  return null;
}
