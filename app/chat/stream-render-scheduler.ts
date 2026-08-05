import type { ChatStreamEvent } from "../../lib/chat-protocol";

/** Keep token updates below the Markdown parser's per-frame work budget. */
export const STREAM_RENDER_INTERVAL_MS = 16;

/** State changes should be visible immediately; text can wait for the batch. */
export function isStructuralStreamEvent(event: Pick<ChatStreamEvent, "type">): boolean {
  return event.type !== "content" && event.type !== "reasoning";
}
