import "server-only";

import type { ChatRequest } from "../../lib/chat-protocol";
import { streamDeepSeekChat } from "../providers/deepseek/deepseek-adapter";

export function createChatEventStream(
  chatRequest: ChatRequest,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const encode = (event: { type: string; [key: string]: unknown }) =>
    encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(
        encode({
          type: "meta",
          model: chatRequest.model,
          thinking: chatRequest.thinking,
          reasoningEffort: chatRequest.reasoningEffort,
        }),
      );

      let sentDone = false;
      let usage = null;
      try {
        for await (const event of streamDeepSeekChat(chatRequest, signal)) {
          if (event.type === "done") {
            usage = event.usage ?? usage;
            if (event.usage === null) continue;
            sentDone = true;
            continue;
          }
          controller.enqueue(encode(event));
        }
        controller.enqueue(encode({ type: "done", usage }));
        controller.close();
      } catch (error: unknown) {
        if (signal.aborted) {
          controller.close();
          return;
        }
        const message = error instanceof Error ? error.message : "DeepSeek is unavailable.";
        controller.enqueue(encode({ type: "error", message }));
        if (!sentDone) controller.enqueue(encode({ type: "done", usage }));
        controller.close();
      }
    },
  });
}
