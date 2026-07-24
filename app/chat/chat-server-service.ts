import "server-only";

import { randomUUID, createHash } from "node:crypto";
import type { ChatAssistantRound, ChatRequest, ChatStreamEvent, ChatToolCall } from "../../lib/chat-protocol";
import { streamDeepSeekChatRound } from "../providers/deepseek/deepseek-adapter";
import { availableChatTools, executePythonTool, PYTHON_TOOL_NAME } from "../server/agent/python-tool";
import { runPythonInstructionsFor } from "../server/agent/python-tool-instructions";
import { isModalConfigured, ModalPythonExecutor } from "../server/modal/modal-python-executor";
import { latestNonNullUsage, sumRoundUsage } from "./chat-usage";

const MAX_RESPONSE_MS = 240_000;
const MAX_TOOL_CALLS = 6;

function encodeEvent(encoder: TextEncoder, event: ChatStreamEvent): Uint8Array {
  return encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function stableConversationId(request: ChatRequest): string {
  if (request.conversationId) return request.conversationId;
  return createHash("sha256")
    .update(JSON.stringify(request.messages.slice(0, 2)))
    .digest("hex")
    .slice(0, 32);
}

export function createChatEventStream(
  chatRequest: ChatRequest,
  ownerId: string,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const responseDeadlineAt = Date.now() + MAX_RESPONSE_MS;
  const encoder = new TextEncoder();
  const responseId = randomUUID();
  const conversationId = stableConversationId(chatRequest);
  const toolDefinitions = availableChatTools();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (event: ChatStreamEvent) => {
        if (!signal.aborted) controller.enqueue(encodeEvent(encoder, event));
      };
      enqueue({
        type: "meta",
        model: chatRequest.model,
        thinking: chatRequest.thinking,
        reasoningEffort: chatRequest.reasoningEffort,
        responseId,
        ...(toolDefinitions.length ? { tools: [PYTHON_TOOL_NAME] } : {}),
      });

      const deadline = AbortSignal.timeout(Math.max(0, responseDeadlineAt - Date.now()));
      const roundSignal = AbortSignal.any([signal, deadline]);
      const replayRounds: ChatAssistantRound[] = [];
      const roundUsages: Array<ReturnType<typeof latestNonNullUsage>> = [];
      let totalToolCalls = 0;
      let executor: ModalPythonExecutor | null = null;

      try {
        for (let round = 1; round <= MAX_TOOL_CALLS + 1; round += 1) {
          enqueue({ type: "round", round });
          const canCallTools = totalToolCalls < MAX_TOOL_CALLS && round <= MAX_TOOL_CALLS;
          const systemInstructions = runPythonInstructionsFor(Boolean(toolDefinitions.length && canCallTools));
          const reasoningParts: string[] = [];
          const contentParts: string[] = [];
          const calls: ChatToolCall[] = [];
          const roundUsageIndex = roundUsages.push(null) - 1;
          for await (const event of streamDeepSeekChatRound(
            chatRequest,
            {
              replayRounds,
              systemInstructions,
              ...(toolDefinitions.length && canCallTools ? { tools: toolDefinitions } : {}),
            },
            roundSignal,
          )) {
            if (event.type === "reasoning") {
              reasoningParts.push(event.delta);
              enqueue(event);
            } else if (event.type === "content") {
              contentParts.push(event.delta);
            } else if (event.type === "tool_call") {
              calls.push(event.call);
            } else if (event.type === "done") {
              roundUsages[roundUsageIndex] = latestNonNullUsage(roundUsages[roundUsageIndex], event.usage);
            } else if (event.type === "error") {
              enqueue(event);
            }
          }

          if (!calls.length) {
            if (contentParts.length) enqueue({ type: "content", delta: contentParts.join("") });
            break;
          }
          if (!isModalConfigured() || !toolDefinitions.length) {
            // The tool is never advertised in this mode, but fail closed if a
            // provider nevertheless emits one.
            enqueue({ type: "error", message: "Python execution is not configured." });
            break;
          }
          if (totalToolCalls + calls.length > MAX_TOOL_CALLS) {
            enqueue({ type: "error", message: "The response reached the 6-call Python limit." });
            break;
          }
          if (!executor) executor = new ModalPythonExecutor(ownerId, conversationId, responseDeadlineAt);

          for (const call of calls) {
            totalToolCalls += 1;
            enqueue({ type: "tool_call", call });
            const result = await executePythonTool(call, executor, ownerId, conversationId);
            call.result = result;
            enqueue({ type: "tool_result", result });
            for (const artifact of result.artifacts ?? []) enqueue({ type: "artifact", artifact });
          }
          replayRounds.push({
            content: contentParts.join(""),
            ...(reasoningParts.length ? { reasoning: reasoningParts.join("") } : {}),
            toolCalls: calls,
          });
        }
      } catch (error: unknown) {
        if (!signal.aborted) {
          const message = deadline.aborted ? "The response exceeded its 240-second limit." : error instanceof Error ? error.message : "DeepSeek is unavailable.";
          enqueue({ type: "error", message });
        }
      } finally {
        await executor?.close().catch(() => undefined);
        if (!signal.aborted) {
          enqueue({ type: "done", usage: sumRoundUsage(roundUsages) });
          controller.close();
        } else {
          controller.close();
        }
      }
    },
  });
}
