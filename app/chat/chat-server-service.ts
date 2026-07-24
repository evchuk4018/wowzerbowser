import "server-only";

import { createHash } from "node:crypto";
import type { ChatAssistantRound, ChatRequest, ChatStreamEvent, ChatToolCall, ChatToolResult } from "../../lib/chat-protocol";
import { streamDeepSeekChatRound } from "../providers/deepseek/deepseek-adapter";
import { availableChatTools, executePythonTool } from "../server/agent/python-tool";
import { runPythonInstructionsFor } from "../server/agent/python-tool-instructions";
import { availableWebTools, executeWebTool } from "../server/agent/web-tools";
import { webToolInstructionsFor } from "../server/agent/web-tool-instructions";
import { isModalConfigured, ModalPythonExecutor } from "../server/modal/modal-python-executor";
import { latestNonNullUsage, sumRoundUsage } from "./chat-usage";

const MAX_RESPONSE_MS = 240_000;
const MAX_TOOL_CALLS = 6;

function stableConversationId(request: ChatRequest): string {
  if (request.conversationId) return request.conversationId;
  return createHash("sha256")
    .update(JSON.stringify(request.messages.slice(0, 2)))
    .digest("hex")
    .slice(0, 32);
}

export async function generateChatResponse(
  chatRequest: ChatRequest,
  ownerId: string,
  signal: AbortSignal,
  persistEvent: (event: ChatStreamEvent) => Promise<void>,
): Promise<void> {
  const responseDeadlineAt = Date.now() + MAX_RESPONSE_MS;
  const responseId = chatRequest.jobId;
  const conversationId = stableConversationId(chatRequest);
  const pythonTools = availableChatTools();
  const webTools = availableWebTools();
  const toolDefinitions = [...pythonTools, ...webTools];

  const enqueue = async (event: ChatStreamEvent) => {
    if (!signal.aborted) await persistEvent(event);
  };
      await enqueue({
        type: "meta",
        model: chatRequest.model,
        thinking: chatRequest.thinking,
        reasoningEffort: chatRequest.reasoningEffort,
        responseId,
        ...(toolDefinitions.length ? { tools: toolDefinitions.map((tool) => tool.function.name) } : {}),
      });

      const deadline = AbortSignal.timeout(Math.max(0, responseDeadlineAt - Date.now()));
      const roundSignal = AbortSignal.any([signal, deadline]);
      const replayRounds: ChatAssistantRound[] = [];
      const roundUsages: Array<ReturnType<typeof latestNonNullUsage>> = [];
      let totalToolCalls = 0;
      let executor: ModalPythonExecutor | null = null;

      try {
        for (let round = 1; round <= MAX_TOOL_CALLS + 1; round += 1) {
          await enqueue({ type: "round", round });
          const canCallTools = totalToolCalls < MAX_TOOL_CALLS && round <= MAX_TOOL_CALLS;
          const systemInstructions = [
            ...runPythonInstructionsFor(Boolean(pythonTools.length && canCallTools)),
            ...webToolInstructionsFor(Boolean(webTools.length && canCallTools)),
          ];
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
              await enqueue(event);
            } else if (event.type === "content") {
              contentParts.push(event.delta);
              await enqueue(event);
            } else if (event.type === "tool_call") {
              calls.push(event.call);
            } else if (event.type === "done") {
              roundUsages[roundUsageIndex] = latestNonNullUsage(roundUsages[roundUsageIndex], event.usage);
            } else if (event.type === "error") {
              await enqueue(event);
            }
          }

          if (!calls.length) {
            break;
          }
          if (!toolDefinitions.length) {
            await enqueue({ type: "error", message: "Tool execution is not configured." });
            break;
          }
          if (totalToolCalls + calls.length > MAX_TOOL_CALLS) {
            await enqueue({ type: "error", message: "The response reached the 6-call tool limit." });
            break;
          }
          for (const call of calls) {
            totalToolCalls += 1;
            await enqueue({ type: "tool_call", call });
            let result: ChatToolResult;
            if (call.name === "run_python") {
              if (!isModalConfigured()) throw new Error("Python execution is not configured.");
              if (!executor) executor = new ModalPythonExecutor(ownerId, conversationId, responseDeadlineAt);
              result = await executePythonTool(call, executor, ownerId, conversationId);
            } else {
              result = await executeWebTool(call);
            }
            call.result = result;
            await enqueue({ type: "tool_result", result });
            for (const artifact of result.artifacts ?? []) await enqueue({ type: "artifact", artifact });
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
          await enqueue({ type: "error", message });
        }
      } finally {
        await executor?.close().catch(() => undefined);
        if (!signal.aborted) {
          await enqueue({ type: "done", usage: sumRoundUsage(roundUsages) });
        }
      }
}
