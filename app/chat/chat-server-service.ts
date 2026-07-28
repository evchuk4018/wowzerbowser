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
import { availablePdfTools, executePdfTool } from "../server/agent/pdf-tool";
import { getAuthorizedDocument, getDocumentPages } from "../server/chat/chat-document-store";
import { availablePdfEditTools } from "../server/agent/pdf-edit-tool-manifest";
import { executePdfEditTool } from "../server/agent/pdf-edit-tool";
import { PDF_EDIT_TOOL_INSTRUCTIONS } from "../server/agent/pdf-edit-tool-instructions";
import { ingestDocx, ingestPdf } from "../server/chat/chat-document-service";
import { DOCX_CONTENT_TYPE, documentContext } from "../../lib/chat-document";
import { IncrementalCitationFilter, parseCitationMarkup, validCitationSources, type ChatSource } from "../../lib/chat-citations";
import { PHASE_BREAK_INSTRUCTIONS } from "../server/agent/phase-break-instructions";
import { executePhaseBreak, PHASE_BREAK_TOOL_DEFINITION, PHASE_BREAK_TOOL_NAME } from "../server/agent/phase-break-tool";
import { ReasoningTitleCoordinator, type ReasoningTitleUsage } from "../server/chat/reasoning-title-service";
import { listEnabledExecutableTools } from "../server/tools/custom-tool-repository";
import { customToolDefinitions, customToolInstructions } from "../server/tools/custom-tool-manifest";
import { executeCustomToolCall } from "../server/tools/custom-tool-executor";
import { chatMemoryToolDefinitions, executeChatMemoryTool } from "../server/agent/chat-memory-tool";
import { recordUsage } from "../server/usage/usage-store";

const MAX_RESPONSE_MS = 240_000;

export type ChatRoundUsage = {
  round: number;
  usage: ChatUsage | null;
  estimatedUsage: ChatUsage;
};

export type ChatSummaryUsage = ReasoningTitleUsage;

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
  persistSummaryUsage?: (usage: ChatSummaryUsage) => Promise<void>,
): Promise<void> {
  const responseDeadlineAt = Date.now() + MAX_RESPONSE_MS;
  const responseId = chatRequest.jobId;
  const conversationId = stableConversationId(chatRequest);
  const pythonTools = availableChatTools();
  const webTools = availableWebTools();
  const customTools = isModalConfigured()
    ? await listEnabledExecutableTools(ownerId).catch((error) => {
        console.warn({ event: "custom-tools-unavailable", ownerId, failure: error instanceof Error ? error.name : "UnknownError" });
        return [];
      })
    : [];
  const customToolsByName = new Map(customTools.map((tool) => [tool.name, tool]));
  const customDefinitions = customToolDefinitions(customTools);
  const chatMemoryTools = chatMemoryToolDefinitions();
  const allowedImageIds = await getAuthoritativeChatImageIdsForRequest(ownerId, chatRequest);
  const requestedPdfIds = [...new Set(chatRequest.messages.flatMap((message) => message.documents?.map((item) => item.id) ?? []))];
  const allowedPdfIds = new Set<string>();
  const authoritativePdfs = new Map<string, NonNullable<Awaited<ReturnType<typeof getAuthorizedDocument>>>>();
  for (const pdfId of requestedPdfIds) {
    const document = await getAuthorizedDocument(ownerId, conversationId, pdfId);
    if (document) { allowedPdfIds.add(pdfId); authoritativePdfs.set(pdfId, document); }
  }
  const contextualMessages = await Promise.all(chatRequest.messages.map(async (message) => {
    const documents = (message.documents ?? []).filter((item) => allowedPdfIds.has(item.id));
    if (!documents.length) return message;
    const contexts = await Promise.all(documents.map(async ({ id }) => documentContext(authoritativePdfs.get(id)!, await getDocumentPages(ownerId, conversationId, id))));
    return { ...message, content: `${message.content}\n\n${contexts.join("\n\n")}` };
  }));
  chatRequest = { ...chatRequest, messages: contextualMessages };
  const imageTools = availableImageTools(allowedImageIds.length > 0);
  const pdfEditTools = availablePdfEditTools([...authoritativePdfs.values()].some((document) => document.contentType === "application/pdf"));
  const allowedProjectIds = new Set([...authoritativePdfs.values()].map((document) => document.projectId).filter((projectId): projectId is string => Boolean(projectId)));
  const phaseTools = chatRequest.thinking ? [PHASE_BREAK_TOOL_DEFINITION] : [];
  const baseToolDefinitions = [...pythonTools, ...imageTools, ...webTools, ...pdfEditTools, ...phaseTools, ...customDefinitions, ...chatMemoryTools];
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
        ...(baseToolDefinitions.length || allowedPdfIds.size ? { tools: [...baseToolDefinitions.map((tool) => tool.function.name), ...availablePdfTools(allowedPdfIds.size > 0).map((tool) => tool.function.name)] } : {}),
      });

      const deadline = AbortSignal.timeout(Math.max(0, responseDeadlineAt - Date.now()));
      const roundSignal = AbortSignal.any([signal, deadline]);
      const titleCoordinator = new ReasoningTitleCoordinator({
        signal: roundSignal,
        emit: enqueue,
        onUsage: persistSummaryUsage,
      });
      const replayRounds: ChatAssistantRound[] = [];
      const roundUsages: Array<ReturnType<typeof latestNonNullUsage>> = [];
      let executor: ModalPythonExecutor | null = null;
      const recalledContexts = new Map<string, string>();
      let currentPhase = 1;
      const sourceCatalog = new Map<string, ChatSource>();

      try {
        for (let round = 1; ; round += 1) {
          const toolDefinitions = [...baseToolDefinitions, ...availablePdfTools(allowedPdfIds.size > 0)];
          await enqueue({ type: "round", round });
          const systemInstructions = [
            ...runPythonInstructionsFor(Boolean(pythonTools.length)),
            ...webToolInstructionsFor(Boolean(webTools.length)),
            ...(pdfEditTools.length ? PDF_EDIT_TOOL_INSTRUCTIONS : []),
            ...(phaseTools.length ? [PHASE_BREAK_INSTRUCTIONS] : []),
            ...customToolInstructions(customTools),
          ];
          const reasoningParts: string[] = [];
          const contentParts: string[] = [];
          const citationFilter = new IncrementalCitationFilter();
          const calls: ChatToolCall[] = [];
          const roundUsageIndex = roundUsages.push(null) - 1;
          let providerAccepted = false;
          try {
            for await (const event of streamDeepSeekChatRound(
              chatRequest,
              {
                replayRounds,
                systemInstructions,
                ...(toolDefinitions.length ? { tools: toolDefinitions } : {}),
                onResponse: (accepted) => {
                  providerAccepted = accepted;
                },
              },
              roundSignal,
            )) {
              if (event.type === "reasoning") {
                reasoningParts.push(event.delta);
                titleCoordinator.append(event.delta);
                await enqueue(event);
              } else if (event.type === "content") {
                contentParts.push(event.delta);
                const delta = citationFilter.push(event.delta);
                if (delta) await enqueue({ type: "content", delta });
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
            const finished = citationFilter.finish();
            if (finished.trailingContent) await enqueue({ type: "content", delta: finished.trailingContent });
            const parsed = parseCitationMarkup(finished.markup, validCitationSources([...sourceCatalog.values()]));
            await enqueue({ type: "annotations", annotations: parsed.annotations, sources: validCitationSources([...sourceCatalog.values()]) });
            break;
          }
          if (!toolDefinitions.length) {
            await enqueue({ type: "error", message: "Tool execution is not configured." });
            break;
          }
          for (const [callIndex, call] of calls.entries()) {
            if (call.name === PHASE_BREAK_TOOL_NAME) {
              currentPhase += 1;
              await titleCoordinator.breakPhase(currentPhase);
              const phaseBreak = executePhaseBreak(call, currentPhase);
              call.result = phaseBreak.result;
              await enqueue({
                type: "phase_break",
                phase: currentPhase,
                ...(phaseBreak.update ? { update: phaseBreak.update } : {}),
                call,
                result: phaseBreak.result,
              });
              continue;
            }
            await enqueue({ type: "tool_call", call });
            let result: ChatToolResult;
            if (call.name === "run_python") {
              if (!isModalConfigured()) throw new Error("Python execution is not configured.");
              if (!executor) executor = new ModalPythonExecutor(ownerId, conversationId, responseDeadlineAt);
              result = await executePythonTool(call, executor, ownerId, conversationId, async (artifact, bytes) => {
                const pdfId = artifact.id;
                if (artifact.contentType === DOCX_CONTENT_TYPE) await ingestDocx({ ownerId, conversationId, documentId: pdfId, filename: artifact.name, bytes, jobId: responseId, signal: roundSignal, projectId: artifact.projectId, revisionId: artifact.revisionId, parentRevisionId: artifact.parentRevisionId, origin: artifact.origin, editable: artifact.editable, sourceCompleteness: artifact.sourceCompleteness });
                else await ingestPdf({ ownerId, conversationId, pdfId, filename: artifact.name, bytes, jobId: responseId, projectId: artifact.projectId, revisionId: artifact.revisionId, parentRevisionId: artifact.parentRevisionId, origin: artifact.origin, editable: artifact.editable, sourceCompleteness: artifact.sourceCompleteness });
                allowedPdfIds.add(pdfId);
              });
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
            } else if (customToolsByName.has(call.name)) {
              result = await executeCustomToolCall(call, customToolsByName.get(call.name)!);
            } else if (chatMemoryTools.some((tool) => tool.function.name === call.name)) {
              result = await executeChatMemoryTool(call, {
                ownerId,
                signal: roundSignal,
                contextCache: recalledContexts,
                onRecallUsage: async ({ model, usage }) => {
                  await recordUsage({
                    ownerId,
                    provider: "deepseek",
                    model,
                    requestKind: "chat_recall",
                    requestId: responseId ?? `chat-${conversationId}`,
                    round: round * 10_000 + callIndex,
                    usage,
                    source: "exact",
                    conversationId,
                    jobId: responseId,
                  });
                },
              });
            } else if (pdfEditTools.some((tool) => tool.function.name === call.name)) {
              if (!isModalConfigured() && call.name !== "inspect_pdf_editability" && call.name !== "compare_document_revisions") throw new Error("PDF editing is not configured.");
              if (!executor && call.name !== "inspect_pdf_editability" && call.name !== "compare_document_revisions") executor = new ModalPythonExecutor(ownerId, conversationId, responseDeadlineAt);
              result = await executePdfEditTool(call, { ownerId, conversationId, allowedPdfIds, allowedImageIds: new Set(allowedImageIds), allowedProjectIds, executor: executor ?? undefined, jobId: responseId });
              for (const artifact of result.artifacts ?? []) if (artifact.contentType === "application/pdf") allowedPdfIds.add(artifact.id);
            } else if (availablePdfTools(allowedPdfIds.size > 0).some((tool) => tool.function.name === call.name)) {
              result = await executePdfTool(call, { ownerId, conversationId, allowedPdfIds });
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
            const web = result.web;
            const sources = web?.kind === "search" ? web.results : web?.kind === "page" ? [web.source] : [];
            for (const source of sources) sourceCatalog.set(source.id, source);
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
        if (signal.aborted) titleCoordinator.cancel();
        else await titleCoordinator.finish();
        await executor?.close().catch(() => undefined);
        if (!signal.aborted) {
          await enqueue({ type: "done", usage: sumRoundUsage(roundUsages) });
        }
      }
}
