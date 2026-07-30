import "server-only";

import { createHash } from "node:crypto";
import type { ChatAssistantRound, ChatModelPricing, ChatRequest, ChatStreamEvent, ChatToolCall, ChatToolResult, ChatUsage } from "../../lib/chat-protocol";
import { estimateUsageFromText } from "../../lib/usage-pricing";
import { chatProviderAdapter } from "../server/chat/chat-provider-registry";
import { authorizeAutomationModel, authorizeChatModel } from "../server/chat/chat-model-catalog-service";
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
import { executeUserMemoryTool, userMemoryToolDefinitions } from "../server/agent/user-memory-tool";
import { USER_MEMORY_TOOL_INSTRUCTIONS } from "../server/agent/user-memory-tool-instructions";
import { RESPONSE_STYLE_INSTRUCTIONS } from "../server/agent/response-style-instructions";
import { recordUsage } from "../server/usage/usage-store";
import { TODO_TOOL_DEFINITIONS, executeTodoTool } from "../server/agent/todo-tool";
import { getTodoList } from "../server/chat/chat-todo-store";
import { planTodos } from "../server/chat/chat-todo-planner";
import { listOwnerSkills } from "../server/skills/skill-service";
import { skillCatalogInstructions } from "../server/agent/skill-instructions";
import { executeReadSkillTool } from "../server/agent/skill-tool";
import { READ_SKILL_TOOL_NAME, SKILL_TOOL_DEFINITIONS } from "../server/agent/skill-tool-manifest";
import { builtinSkillFallbacks } from "../server/skills/builtin-skills";
import { AUTOMATION_SKILL_KEY, AUTOMATION_TOOL_DEFINITIONS } from "../server/agent/automation-tool-manifest";
import { executeAutomationTool } from "../server/agent/automation-tool";
import { COMPLETE_AUTOMATION_RUN_TOOL_DEFINITION, COMPLETE_AUTOMATION_RUN_TOOL_NAME, executeCompleteAutomationRun, type AutomationRunResult } from "../server/agent/automation-run-result-tool";

const MAX_RESPONSE_MS = 240_000;

export type ChatRoundUsage = {
  round: number;
  usage: ChatUsage | null;
  estimatedUsage: ChatUsage;
  provider: "deepseek" | "openrouter";
  model: string;
  exactCostUsd?: number;
  pricing?: ChatModelPricing | null;
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
  executionOptions: { profile?: "chat" | "automation"; onAutomationResult?: (result: AutomationRunResult) => void } = {},
): Promise<void> {
  const automationExecution = executionOptions.profile === "automation";
  if (typeof chatRequest.model === "string") {
    chatRequest = { ...chatRequest, model: { provider: "deepseek", model: chatRequest.model } };
  }
  const selectedMetadata = await (automationExecution ? authorizeAutomationModel(ownerId, chatRequest.model) : authorizeChatModel(ownerId, chatRequest.model));
  const providerAdapter = chatProviderAdapter(chatRequest.model.provider);
  providerAdapter.assertConfigured();
  const responseDeadlineAt = Date.now() + MAX_RESPONSE_MS;
  const responseId = chatRequest.jobId;
  const conversationId = stableConversationId(chatRequest);
  const currentTodos = automationExecution ? { revision: 0, items: [] } : await getTodoList(ownerId, conversationId).catch(() => ({ revision: 0, items: [] }));
  const latestPreviousAssistant = [...chatRequest.messages].reverse().find((message) => message.role === "assistant")?.content;
  const planner = automationExecution ? null : await planTodos({
    ownerId,
    conversationId,
    userMessage: chatRequest.messages.at(-1)?.content ?? "",
    previousAssistantOutput: latestPreviousAssistant,
    current: currentTodos,
    signal,
    onUsage: async (answer) => {
      await recordUsage({
        ownerId,
        provider: "openrouter",
        model: answer.model,
        requestKind: "todo_planner",
        requestId: responseId ?? `todo-${conversationId}`,
        round: 0,
        usage: answer.usage ?? answer.estimatedUsage,
        source: answer.usage ? "exact" : "estimated",
        exactCostUsd: answer.exactCostUsd,
        unpriced: answer.exactCostUsd === undefined,
        conversationId,
        jobId: responseId,
      }).catch(() => undefined);
    },
  });
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
  const chatMemoryTools = automationExecution ? [] : chatMemoryToolDefinitions();
  const userMemoryTools = automationExecution ? [] : userMemoryToolDefinitions();
  const skills = automationExecution ? [] : await listOwnerSkills(ownerId).catch((error) => {
    console.warn({ event: "skills-unavailable", ownerId, failure: error instanceof Error ? error.name : "UnknownError" });
    return builtinSkillFallbacks();
  });
  const skillsById = new Map(skills.map((skill) => [skill.id, skill]));
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
  const phaseTools = chatRequest.thinking && !automationExecution ? [PHASE_BREAK_TOOL_DEFINITION] : [];
  const baseToolDefinitions = [...pythonTools, ...imageTools, ...webTools, ...pdfEditTools, ...phaseTools, ...customDefinitions, ...chatMemoryTools, ...userMemoryTools, ...(automationExecution ? [] : SKILL_TOOL_DEFINITIONS), ...(automationExecution ? [] : TODO_TOOL_DEFINITIONS), ...(automationExecution ? [COMPLETE_AUTOMATION_RUN_TOOL_DEFINITION] : [])];
  const imageToolAdvertised = imageTools.some((tool) => tool.function.name === INSPECT_IMAGE_TOOL_NAME);

  const enqueue = async (event: ChatStreamEvent) => {
    if (!signal.aborted) await persistEvent(event);
  };
      if (planner) await enqueue({ type: "todo_update", todos: planner });
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
      let automationToolsUnlocked = false;
      const sourceCatalog = new Map<string, ChatSource>();

      try {
        for (let round = 1; ; round += 1) {
          const automationDefinitions = !automationExecution && automationToolsUnlocked ? AUTOMATION_TOOL_DEFINITIONS : [];
          const toolDefinitions = [...baseToolDefinitions, ...automationDefinitions, ...availablePdfTools(allowedPdfIds.size > 0)];
          await enqueue({ type: "round", round });
          const systemInstructions = [
            ...runPythonInstructionsFor(Boolean(pythonTools.length)),
            ...webToolInstructionsFor(Boolean(webTools.length)),
            ...(pdfEditTools.length ? PDF_EDIT_TOOL_INSTRUCTIONS : []),
            ...(phaseTools.length ? [PHASE_BREAK_INSTRUCTIONS] : []),
            ...customToolInstructions(customTools),
            skillCatalogInstructions(skills),
            USER_MEMORY_TOOL_INSTRUCTIONS,
            RESPONSE_STYLE_INSTRUCTIONS,
          ];
          const reasoningParts: string[] = [];
          const contentParts: string[] = [];
          const citationFilter = new IncrementalCitationFilter();
          const calls: ChatToolCall[] = [];
          const reasoningDetails: unknown[] = [];
          const roundUsageIndex = roundUsages.push(null) - 1;
          let providerAccepted = false;
          let actualModel = chatRequest.model.model;
          let exactCostUsd: number | undefined;
          let pricing: ChatModelPricing | null | undefined = selectedMetadata.pricing;
          try {
            for await (const event of providerAdapter.streamRound(
              chatRequest,
              selectedMetadata,
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
              } else if (event.type === "reasoning_details") {
                reasoningDetails.push(...event.details);
              } else if (event.type === "content") {
                contentParts.push(event.delta);
                const delta = citationFilter.push(event.delta);
                if (delta) await enqueue({ type: "content", delta });
              } else if (event.type === "tool_call") {
                calls.push(event.call);
              } else if (event.type === "done") {
                roundUsages[roundUsageIndex] = latestNonNullUsage(roundUsages[roundUsageIndex], event.usage);
                actualModel = event.model ?? actualModel;
                exactCostUsd = event.exactCostUsd ?? exactCostUsd;
                pricing = event.pricing ?? pricing;
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
                provider: chatRequest.model.provider,
                model: actualModel,
                ...(exactCostUsd === undefined ? {} : { exactCostUsd }),
                pricing,
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
                onRecallUsage: async ({ model, usage, exactCostUsd }) => {
                  await recordUsage({
                    ownerId,
                    provider: "openrouter",
                    model,
                    requestKind: "chat_recall",
                    requestId: responseId ?? `chat-${conversationId}`,
                    round: round * 10_000 + callIndex,
                    usage,
                    source: "exact",
                    exactCostUsd,
                    unpriced: exactCostUsd === undefined,
                    conversationId,
                    jobId: responseId,
                  });
                },
              });
            } else if (userMemoryTools.some((tool) => tool.function.name === call.name)) {
              result = await executeUserMemoryTool(call, {
                ownerId,
                conversationId,
                jobId: responseId ?? `chat-${conversationId}`,
              });
            } else if (call.name === READ_SKILL_TOOL_NAME) {
              result = executeReadSkillTool(call, skillsById);
              if (result.ok) {
                try {
                  const skillId = (JSON.parse(call.arguments) as { skillId?: unknown }).skillId;
                  if (typeof skillId === "string" && skillsById.get(skillId)?.builtinKey === AUTOMATION_SKILL_KEY) automationToolsUnlocked = true;
                } catch {}
              }
            } else if (automationDefinitions.some((tool) => tool.function.name === call.name)) {
              result = await executeAutomationTool(call, ownerId);
            } else if (automationExecution && call.name === COMPLETE_AUTOMATION_RUN_TOOL_NAME) {
              const completed = executeCompleteAutomationRun(call);
              result = completed.result;
              if (completed.value) executionOptions.onAutomationResult?.(completed.value);
            } else if (TODO_TOOL_DEFINITIONS.some((tool) => tool.function.name === call.name)) {
              result = await executeTodoTool(call, {
                ownerId,
                conversationId,
                onUpdate: async (todos) => enqueue({ type: "todo_update", todos }),
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
            ...(reasoningDetails.length ? { reasoningDetails } : {}),
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
