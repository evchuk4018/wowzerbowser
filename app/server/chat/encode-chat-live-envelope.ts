import type { ChatLiveStreamEnvelope } from "../../../lib/chat-protocol";

const encoder = new TextEncoder();

export function encodeChatLiveEnvelope(envelope: ChatLiveStreamEnvelope): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(envelope)}\n\n`);
}
