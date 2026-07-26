import "server-only";

import { createHash } from "node:crypto";
import type { ChatAssistantRound, ChatRequest, ChatStreamEvent, ChatToolCall, ChatToolResult, ChatUsage } from "../../lib/chat-protocol";
import { estimateUsageFromText } from "../../lib/usage-pricing";
import { streamDeepSeekChatRound } from "../providers/deepseek/deepseek-adapter";
import { availableChatTools, executePythonTool } from "../server/agent/python-tool";
import { runPythonInstructionsFor } from "../server/agent/python-tool-instructions";
import { availableWebTools, executeWebTool } from "../server/agent/web-tools";
import { webToolInstructionsFor } from "../server/agent/web-tool-instructions";
import {
  availableImageTools,
  executeInspectImageTool,
  INSPECT_IMAGE_TOOL_NAME,
} from "../server/agent/image-tool";
import { isModalConfigured, ModalPythonExecutor } from "../server/modal/modal-python-executor";
import { getAuthoritativeChatImageIdsForRequest } from "../server/chat/chat-history-store";
import { latestNonNullUsage, sumRoundUsage } from "./chat-usage";

const MAX_RESPONSE_MS = 240_000;
const MAX_TOOL_CALLS = 6;

export type ChatRoundUsage = {
  round: number;
  usage: ChatUsage | null;
  estimatedUsage: ChatUsage;
};

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
  persistUsage?: (usage: ChatRoundUsage) => Promise<void>,
): Promise<void> {
  const responseDeadlineAt = Date.now() + MAX_RESPONSE_MS;
  const responseId = chatRequest.jobId;
  const conversationId = stableConversationId(chatRequest);
  const pythonTools = availableChatTools();
  const webTools = availableWebTools();
  const allowedImageIds = await getAuthoritativeChatImageIdsForRequest(ownerId, chatRequest);
  const imageTools = availableImageTools(allowedImageIds.length > 0);
  const toolDefinitions = [...pythonTools, ...imageTools, ...webTools];
  const imageToolAdvertised = imageTools.some((tool) => tool.function.name === INSPECT_IMAGE_TOOL_NAME);

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
          let providerAccepted = false;
          try {
            for await (const event of streamDeepSeekChatRound(
              chatRequest,
              {
                replayRounds,
                systemInstructions,
                ...(toolDefinitions.length && canCallTools ? { tools: toolDefinitions } : {}),
                onResponse: (accepted) => {
                  providerAccepted = accepted;
                },
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
          } finally {
            if (providerAccepted) {
              await persistUsage?.({
                round,
                usage: roundUsages[roundUsageIndex],
                estimatedUsage: estimateUsageFromText(
                  JSON.stringify({
                    messages: chatRequest.messages,
                    systemPrompt: chatRequest.systemPrompt,
                    userPresence: chatRequest.userPresence,
                    replayRounds,
                    systemInstructions,
                    tools: toolDefinitions,
                  }),
                  `${reasoningParts.join("")} ${contentParts.join("")} ${calls.map((call) => call.arguments).join(" ")}`,
                ),
              });
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
            } else if (call.name === INSPECT_IMAGE_TOOL_NAME && imageToolAdvertised) {
              result = await executeInspectImageTool(call, {
                ownerId,
                conversationId,
                allowedImageIds,
                signal: roundSignal,
                responseDeadlineAt,
              });
            } else if (webTools.some((tool) => tool.function.name === call.name)) {
              result = await executeWebTool(call);
            } else {
              result = {
                id: call.id,
                name: call.name,
                ok: false,
                stdout: "",
                stderr: `Unknown tool: ${call.name}`,
              };
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
