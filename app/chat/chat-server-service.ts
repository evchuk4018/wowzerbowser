import "server-only";

import { randomUUID, createHash } from "node:crypto";
import type { ChatRequest, ChatStreamEvent, ChatToolCall, ChatUsage } from "../../lib/chat-protocol";
import type { DeepSeekMessage } from "../providers/deepseek/deepseek-adapter";
import { streamDeepSeekChatRound } from "../providers/deepseek/deepseek-adapter";
import { availableChatTools, executePythonTool, PYTHON_TOOL_NAME } from "../server/agent/python-tool";
import { isModalConfigured, ModalPythonExecutor } from "../server/modal/modal-python-executor";

const MAX_RESPONSE_MS = 240_000;
const MAX_TOOL_CALLS = 6;

function historyMessages(request: ChatRequest): DeepSeekMessage[] {
  const history: DeepSeekMessage[] = [
    { role: "system", content: request.systemPrompt },
    ...(request.userPresence ? [{ role: "system" as const, content: request.userPresence }] : []),
  ];
  for (const message of request.messages) {
    if (message.role === "assistant" && message.rounds?.length) {
      for (const round of message.rounds) {
        const calls = round.toolCalls ?? [];
        history.push({
          role: "assistant",
          content: round.content || null,
          ...(round.reasoning ? { reasoning_content: round.reasoning } : {}),
          ...(calls.length
            ? {
                tool_calls: calls.map((call) => ({
                  id: call.id,
                  type: "function" as const,
                  function: { name: call.name, arguments: call.arguments },
                })),
              }
            : {}),
        });
        for (const call of calls) {
          if (call.result) history.push({ role: "tool", content: JSON.stringify(call.result), tool_call_id: call.id, name: call.name });
        }
      }
      continue;
    }
    if (message.role === "assistant") {
      history.push({
        role: "assistant",
        content: message.content,
        ...(message.reasoning ? { reasoning_content: message.reasoning } : {}),
        ...(message.toolCalls?.length
          ? { tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: call.arguments } })) }
          : {}),
      });
    } else {
      history.push({ role: "user", content: message.content });
    }
  }
  return history;
}

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

      const deadline = AbortSignal.timeout(MAX_RESPONSE_MS);
      const roundSignal = AbortSignal.any([signal, deadline]);
      const providerMessages = historyMessages(chatRequest);
      let usage: ChatUsage | null = null;
      let totalToolCalls = 0;
      let executor: ModalPythonExecutor | null = null;

      try {
        for (let round = 1; round <= MAX_TOOL_CALLS + 1; round += 1) {
          enqueue({ type: "round", round });
          const canCallTools = totalToolCalls < MAX_TOOL_CALLS && round <= MAX_TOOL_CALLS;
          const reasoningParts: string[] = [];
          const contentParts: string[] = [];
          const calls: ChatToolCall[] = [];
          for await (const event of streamDeepSeekChatRound(
            chatRequest,
            {
              messages: providerMessages,
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
              usage = event.usage ?? usage;
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
          if (!executor) executor = new ModalPythonExecutor(ownerId, conversationId);

          providerMessages.push({
            role: "assistant",
            content: contentParts.join("") || null,
            ...(reasoningParts.length ? { reasoning_content: reasoningParts.join("") } : {}),
            tool_calls: calls.map((item) => ({
              id: item.id,
              type: "function" as const,
              function: { name: item.name, arguments: item.arguments },
            })),
          });
          for (const call of calls) {
            totalToolCalls += 1;
            enqueue({ type: "tool_call", call });
            const result = await executePythonTool(call, executor, ownerId, conversationId);
            enqueue({ type: "tool_result", result });
            for (const artifact of result.artifacts ?? []) enqueue({ type: "artifact", artifact });
            providerMessages.push({
              role: "tool",
              content: JSON.stringify(result),
              tool_call_id: call.id,
              name: call.name,
            });
          }
        }
      } catch (error: unknown) {
        if (!signal.aborted) {
          const message = deadline.aborted ? "The response exceeded its 240-second limit." : error instanceof Error ? error.message : "DeepSeek is unavailable.";
          enqueue({ type: "error", message });
        }
      } finally {
        await executor?.close().catch(() => undefined);
        if (!signal.aborted) {
          enqueue({ type: "done", usage });
          controller.close();
        } else {
          controller.close();
        }
      }
    },
  });
}
