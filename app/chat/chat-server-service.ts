import "server-only";

import { createHash } from "node:crypto";
import type { ChatAssistantRound, ChatModelPricing, ChatRequest, ChatStreamEvent, ChatToolCall, ChatToolResult, ChatUsage } from "../../lib/chat-protocol";
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
import { DOCX_CONTENT_TYPE, createInlineDocumentPageLoader, documentContext } from "../../lib/chat-document";
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
import { AUTOMATION_SKILL_KEY, AUTOMATION_TOOL_DEFINITIONS, messageUnlocksAutomationTools } from "../server/agent/automation-tool-manifest";
import { executeAutomationTool } from "../server/agent/automation-tool";
import { COMPLETE_AUTOMATION_RUN_TOOL_DEFINITION, COMPLETE_AUTOMATION_RUN_TOOL_NAME, executeCompleteAutomationRun, type AutomationRunResult } from "../server/agent/automation-run-result-tool";
import { availableDeepResearchTools } from "../server/agent/deep-research-tool-manifest";
import { executeDeepResearchTool } from "../server/agent/deep-research-tool";
import { deepResearchInstructionsFor } from "../server/agent/deep-research-tool-instructions";
import type { ResearchRun } from "../server/research/research-types";
import { compileFocusedContext, type FocusedContextPlan, type FocusedToolGroup } from "../server/chat/focused-context";
import {
  CURRENT_CHAT_CONTEXT_TOOL_INSTRUCTIONS,
  SEARCH_CURRENT_CHAT_TOOL_DEFINITION,
  SEARCH_CURRENT_CHAT_TOOL_NAME,
} from "../server/agent/current-chat-context-tool-manifest";
import { executeCurrentChatContextTool } from "../server/agent/current-chat-context-tool";
import {
  CALENDAR_SKILL_KEY,
  CALENDAR_TOOL_DEFINITIONS,
  messageUnlocksCalendarTools,
} from "../server/agent/calendar-tool-manifest";
import { executeCalendarTool } from "../server/agent/calendar-tool";
import { getConsolidatedPrompt } from "../server/memory/dreaming-repository";
import { formatConsolidatedPrompt } from "../server/memory/dreaming-prompt";
import { listConnectorCatalog } from "../server/connectors/connector-service";
import { connectorToolsToModelTools, executeConnectorTool, executeSearchConnectorTools, SEARCH_CONNECTOR_TOOLS_DEFINITION, SEARCH_CONNECTOR_TOOLS_NAME } from "../server/connectors/connector-tool-router";
import type { ConnectorTool } from "../../lib/connector-protocol";
import { executeToolBatch, planToolBatches, toolExecutionMetadata } from "../server/agent/tool-execution-policy";
import { ChatUsageEstimator } from "./chat-usage-estimator";

const MAX_RESPONSE_MS = 240_000;

export type ChatRoundUsage = {
  round: number;
  usage: ChatUsage | null;
  estimatedUsage?: ChatUsage;
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
  const latestPreviousAssistant = [...chatRequest.messages].reverse().find((message) => message.role === "assistant")?.content;
  const pythonTools = availableChatTools();
  const webTools = availableWebTools();
  const requestedPdfIds = [...new Set(chatRequest.messages.flatMap((message) => message.documents?.map((item) => item.id) ?? []))];
  const [
    consolidatedMemory,
    currentTodos,
    customTools,
    skills,
    allowedImageIds,
    authorizedDocuments,
    connectorCatalog,
  ] = await Promise.all([
    automationExecution ? Promise.resolve("") : getConsolidatedPrompt(ownerId).catch(() => "").then(formatConsolidatedPrompt),
    automationExecution ? Promise.resolve({ revision: 0, items: [] }) : getTodoList(ownerId, conversationId).catch(() => ({ revision: 0, items: [] })),
    isModalConfigured()
      ? listEnabledExecutableTools(ownerId).catch((error) => {
        console.warn({ event: "custom-tools-unavailable", ownerId, failure: error instanceof Error ? error.name : "UnknownError" });
        return [];
      })
      : Promise.resolve([]),
    automationExecution ? Promise.resolve([]) : listOwnerSkills(ownerId).catch((error) => {
      console.warn({ event: "skills-unavailable", ownerId, failure: error instanceof Error ? error.name : "UnknownError" });
      return builtinSkillFallbacks();
    }),
    getAuthoritativeChatImageIdsForRequest(ownerId, chatRequest),
    Promise.all(requestedPdfIds.map(async (pdfId) => [pdfId, await getAuthorizedDocument(ownerId, conversationId, pdfId)] as const)),
    !automationExecution ? listConnectorCatalog(ownerId).catch((error) => {
      console.warn({ event: "connectors-unavailable", ownerId, failure: error instanceof Error ? error.name : "UnknownError" });
      return [];
    }) : Promise.resolve([]),
  ]);
  const customToolsByName = new Map(customTools.map((tool) => [tool.name, tool]));
  const chatMemoryTools = automationExecution ? [] : chatMemoryToolDefinitions();
  const userMemoryTools = automationExecution ? [] : userMemoryToolDefinitions();
  const skillsById = new Map(skills.map((skill) => [skill.id, skill]));
  const allowedPdfIds = new Set<string>();
  const authoritativePdfs = new Map<string, NonNullable<Awaited<ReturnType<typeof getAuthorizedDocument>>>>();
  for (const [pdfId, document] of authorizedDocuments) {
    if (document) { allowedPdfIds.add(pdfId); authoritativePdfs.set(pdfId, document); }
  }
  const imageTools = availableImageTools(allowedImageIds.length > 0);
  const allPdfEditTools = availablePdfEditTools([...authoritativePdfs.values()].some((document) => document.contentType === "application/pdf"));
  const allPdfReadTools = availablePdfTools(allowedPdfIds.size > 0);
  const phaseTools = chatRequest.thinking && !automationExecution ? [PHASE_BREAK_TOOL_DEFINITION] : [];
  const latestMessage = chatRequest.messages.at(-1);
  const latestUserMessage = [...chatRequest.messages].reverse().find((message) => message.role === "user");
  const automationKeywordUnlock = !automationExecution && chatRequest.messages.some(
    (message) => message.role === "user" && messageUnlocksAutomationTools(message.content),
  );
  const calendarKeywordUnlock = messageUnlocksCalendarTools(latestUserMessage?.content ?? "");
  const connectorDiscoveryAvailable = connectorCatalog.some((connector) => connector.installed && connector.connections.some((connection) => connection.status === "connected"));
  const potentialDeepResearchTools = automationExecution ? [] : availableDeepResearchTools(true);
  const potentialTodoTools = automationExecution ? [] : TODO_TOOL_DEFINITIONS;
  const toolGroups: FocusedToolGroup[] = [
    ...(pythonTools.length ? [{ id: "python", summary: "Run Python for computation, data processing, or generated files.", keywords: ["python", "calculate", "compute", "chart", "spreadsheet", "generate file"], fallback: true }] : []),
    ...(imageTools.length ? [{ id: "image", summary: "Inspect an attached image.", keywords: ["image", "photo", "picture", "screenshot"], required: Boolean(latestMessage?.attachments?.length) }] : []),
    ...(webTools.length ? [{ id: "web", summary: "Search the web, fetch pages, and check current time, date, or deployment location.", keywords: ["current", "latest", "today", "web", "search", "url", "time", "date", "location", "news"], fallback: true }] : []),
    ...(potentialDeepResearchTools.length ? [{ id: "research", summary: "Run substantial multi-source research and inspect its evidence.", keywords: ["research", "sources", "investigate", "compare evidence"], fallback: true }] : []),
    ...(allPdfReadTools.length ? [{ id: "documents", summary: "Search and read authorized PDF or DOCX documents.", keywords: ["document", "pdf", "docx", "page", "attached"], required: Boolean(latestMessage?.documents?.length), fallback: true }] : []),
    ...(allPdfEditTools.length ? [{ id: "document-edit", summary: "Inspect or edit an authorized PDF and compare revisions.", keywords: ["edit pdf", "modify pdf", "change document", "revision", "compare pdf"], fallback: true }] : []),
    ...(phaseTools.length ? [{ id: "phase", summary: "Start a new reasoning phase.", keywords: [], required: true }] : []),
    ...(chatMemoryTools.length ? [{ id: "chat-memory", summary: "Search or recall another saved conversation.", keywords: ["previous chat", "past conversation", "another conversation", "chat history"], fallback: true }] : []),
    ...(userMemoryTools.length ? [{ id: "user-memory", summary: "Browse or maintain durable facts in the private user profile.", keywords: ["remember", "memory", "profile", "forget"], fallback: true }] : []),
    ...(skills.length ? [{ id: "skills", summary: "Load task-specific saved skill instructions.", keywords: skills.flatMap(({ name, summary }) => [name, summary]), fallback: true }] : []),
    ...(automationKeywordUnlock ? [{ id: "automations", summary: "Create and manage recurring automations.", keywords: ["automation", "recurring", "schedule", "daily", "weekly"], required: true }] : []),
    ...(calendarKeywordUnlock ? [{ id: "calendar", summary: "Read and manage the connected primary Google Calendar.", keywords: ["calendar", "calender", "caldner", "calnder"], required: true }] : []),
    ...(connectorDiscoveryAvailable ? [{ id: "connectors", summary: `Discover actions in connected services: ${connectorCatalog.filter((item) => item.installed).map((item) => item.name).join(", ")}.`, keywords: ["gmail", "email", "drive", "file", "notion", "page", "slack", "message", "connected service", "connector", "mcp"], fallback: true }] : []),
    ...customTools.map((tool) => ({ id: `custom:${tool.name}`, summary: tool.description, keywords: [tool.name, tool.description], fallback: true })),
    ...(potentialTodoTools.length ? [{ id: "todos", summary: "Update the visible task todo list.", keywords: ["todo", "plan", "steps", "tasks"], required: true }] : []),
    ...(automationExecution ? [{ id: "automation-result", summary: "Complete the current automation run.", keywords: [], required: true }] : []),
  ];
  const plannerPromise = automationExecution ? Promise.resolve({ list: null, plannedThisTurn: false }) : planTodos({
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
  const focusedPlanPromise: Promise<FocusedContextPlan | null> = !automationExecution && chatRequest.contextMode === "focused"
    ? compileFocusedContext({
      messages: chatRequest.messages,
      toolGroups,
      signal,
      onRouterUsage: async ({ model, usage, estimated, exactCostUsd }) => {
        await recordUsage({
          ownerId,
          provider: "openrouter",
          model,
          requestKind: "context_router",
          requestId: responseId ?? `context-${conversationId}`,
          round: 0,
          usage,
          source: estimated ? "estimated" : "exact",
          exactCostUsd,
          unpriced: exactCostUsd === undefined,
          conversationId,
          jobId: responseId,
        }).catch(() => undefined);
      },
    })
    : Promise.resolve(null);
  const [planner, focusedPlan] = await Promise.all([plannerPromise, focusedPlanPromise]);
  if (focusedPlan) {
    console.info({
      event: "focused-context-compiled",
      ownerId,
      conversationId,
      beforeCharacters: focusedPlan.beforeCharacters,
      afterCharacters: focusedPlan.afterCharacters,
      selectedTurnCount: focusedPlan.selectedTurnIds.length,
      omittedTurnCount: focusedPlan.omittedTurnCount,
      selectedToolGroups: [...focusedPlan.selectedToolGroups],
      routerUsed: focusedPlan.routerUsed,
      routerFallback: focusedPlan.routerFallback,
      selectionReasons: focusedPlan.selectionReasons,
      durationMs: focusedPlan.durationMs,
    });
    chatRequest = { ...chatRequest, messages: focusedPlan.messages };
  }
  const deepResearchTools = !automationExecution && planner.plannedThisTurn && Boolean(planner.list?.items.length)
    ? potentialDeepResearchTools
    : [];
  const selected = (group: string) => !focusedPlan || focusedPlan.selectedToolGroups.has(group);
  const activePythonTools = selected("python") ? pythonTools : [];
  const activeImageTools = selected("image") ? imageTools : [];
  const activeWebTools = selected("web") ? webTools : [];
  const activeDeepResearchTools = selected("research") ? deepResearchTools : [];
  const activePdfReadTools = selected("documents") ? allPdfReadTools : [];
  const pdfEditTools = selected("document-edit") ? allPdfEditTools : [];
  const activePhaseTools = selected("phase") ? phaseTools : [];
  const activeChatMemoryTools = selected("chat-memory") ? chatMemoryTools : [];
  const activeUserMemoryTools = selected("user-memory") ? userMemoryTools : [];
  const activeCustomTools = customTools.filter((tool) => selected(`custom:${tool.name}`));
  let discoveredConnectorTools: ConnectorTool[] = [];
  const customDefinitions = customToolDefinitions(activeCustomTools);
  const skillTools = selected("skills") && !automationExecution ? SKILL_TOOL_DEFINITIONS : [];
  const todoTools = selected("todos") && !automationExecution && (planner.plannedThisTurn || Boolean(planner.list?.items.length)) ? TODO_TOOL_DEFINITIONS : [];
  const automationResultTools = selected("automation-result") && automationExecution ? [COMPLETE_AUTOMATION_RUN_TOOL_DEFINITION] : [];
  const contextTools = focusedPlan?.searchEntries.length ? [SEARCH_CURRENT_CHAT_TOOL_DEFINITION] : [];
  const pagesForInlineDocument = createInlineDocumentPageLoader((document) => getDocumentPages(ownerId, conversationId, document.id));
  const contextualMessages = await Promise.all(chatRequest.messages.map(async (message) => {
    const documents = (message.documents ?? []).filter((item) => allowedPdfIds.has(item.id));
    if (!documents.length) return message;
    const contexts = await Promise.all(documents.map(async ({ id }) => {
      const document = authoritativePdfs.get(id)!;
      return documentContext(document, await pagesForInlineDocument(document));
    }));
    return { ...message, content: `${message.content}\n\n${contexts.join("\n\n")}` };
  }));
  chatRequest = { ...chatRequest, messages: contextualMessages };
  const allowedProjectIds = new Set([...authoritativePdfs.values()].map((document) => document.projectId).filter((projectId): projectId is string => Boolean(projectId)));
  const baseToolDefinitions = [...activePythonTools, ...activeImageTools, ...activeWebTools, ...activeDeepResearchTools, ...pdfEditTools, ...activePhaseTools, ...customDefinitions, ...activeChatMemoryTools, ...activeUserMemoryTools, ...skillTools, ...todoTools, ...automationResultTools, ...contextTools, ...(connectorDiscoveryAvailable && selected("connectors") ? [SEARCH_CONNECTOR_TOOLS_DEFINITION] : [])];
  const imageToolAdvertised = activeImageTools.some((tool) => tool.function.name === INSPECT_IMAGE_TOOL_NAME);

  const enqueue = async (event: ChatStreamEvent) => {
    if (!signal.aborted) await persistEvent(event);
  };
      if (planner.list) await enqueue({ type: "todo_update", todos: planner.list });
      await enqueue({
        type: "meta",
        model: chatRequest.model,
        thinking: chatRequest.thinking,
        reasoningEffort: chatRequest.reasoningEffort,
        responseId,
        ...(baseToolDefinitions.length || activePdfReadTools.length ? { tools: [...baseToolDefinitions.map((tool) => tool.function.name), ...activePdfReadTools.map((tool) => tool.function.name)] } : {}),
      });

      const deadline = AbortSignal.timeout(Math.max(0, responseDeadlineAt - Date.now()));
      const roundSignal = AbortSignal.any([signal, deadline]);
      const titleCoordinator = new ReasoningTitleCoordinator({
        signal: roundSignal,
        emit: enqueue,
        onUsage: persistSummaryUsage,
      });
      const replayRounds: ChatAssistantRound[] = [];
      let usageEstimator: ChatUsageEstimator | null = null;
      const roundUsages: Array<ReturnType<typeof latestNonNullUsage>> = [];
      let executor: ModalPythonExecutor | null = null;
      const recalledContexts = new Map<string, string>();
      let currentPhase = 1;
      let automationToolsUnlocked = automationKeywordUnlock;
      let calendarToolsUnlocked = calendarKeywordUnlock;
      let activeResearchRun: ResearchRun | null = null;
      let connectorModelTools: ReturnType<typeof connectorToolsToModelTools> = [];
      const sourceCatalog = new Map<string, ChatSource>();

      try {
        for (let round = 1; ; round += 1) {
          const automationDefinitions = !automationExecution && automationToolsUnlocked ? AUTOMATION_TOOL_DEFINITIONS : [];
          const calendarDefinitions = calendarToolsUnlocked ? CALENDAR_TOOL_DEFINITIONS : [];
          const dynamicPdfTools = selected("documents")
            ? availablePdfTools(allowedPdfIds.size > 0).filter((tool) => !baseToolDefinitions.some((base) => base.function.name === tool.function.name))
            : [];
          const dynamicConnectorTools = selected("connectors") ? connectorModelTools : [];
          const toolDefinitions = [...baseToolDefinitions, ...automationDefinitions, ...calendarDefinitions, ...dynamicPdfTools, ...dynamicConnectorTools];
          await enqueue({ type: "round", round });
          const systemInstructions = [
            ...runPythonInstructionsFor(Boolean(activePythonTools.length)),
            ...webToolInstructionsFor(Boolean(activeWebTools.length)),
            ...deepResearchInstructionsFor(Boolean(activeDeepResearchTools.length)),
            ...(pdfEditTools.length ? PDF_EDIT_TOOL_INSTRUCTIONS : []),
            ...(activePhaseTools.length ? [PHASE_BREAK_INSTRUCTIONS] : []),
            ...customToolInstructions(activeCustomTools),
            ...(skillTools.length ? [skillCatalogInstructions(skills)] : []),
            ...(activeUserMemoryTools.length ? [USER_MEMORY_TOOL_INSTRUCTIONS] : []),
            ...(calendarDefinitions.length ? [
              "For calendar requests, use list_calendar_events with an explicit RFC 3339 timeMin and timeMax based on the automation timezone or the user's requested timezone.",
            ] : []),
            ...(consolidatedMemory ? [consolidatedMemory] : []),
            ...(contextTools.length ? [CURRENT_CHAT_CONTEXT_TOOL_INSTRUCTIONS] : []),
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
            if (providerAccepted && persistUsage) {
              const providerUsage = roundUsages[roundUsageIndex];
              const estimatedUsage = providerUsage
                ? undefined
                : (usageEstimator ??= new ChatUsageEstimator({
                  messages: chatRequest.messages,
                  systemPrompt: chatRequest.systemPrompt,
                  userPresence: chatRequest.userPresence,
                })).estimate({
                  replayRounds,
                  systemInstructions,
                  tools: toolDefinitions,
                  output: `${reasoningParts.join("")} ${contentParts.join("")} ${calls.map((call) => call.arguments).join(" ")}`,
                });
              await persistUsage({
                round,
                usage: providerUsage,
                ...(estimatedUsage ? { estimatedUsage } : {}),
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
          const executeToolCall = async (call: ChatToolCall, callIndex: number): Promise<ChatToolResult> => {
            if (call.name === "run_python" && activePythonTools.length) {
              if (!isModalConfigured()) throw new Error("Python execution is not configured.");
              if (!executor) executor = new ModalPythonExecutor(ownerId, conversationId, responseDeadlineAt);
              return executePythonTool(call, executor, ownerId, conversationId, async (artifact, bytes) => {
                const pdfId = artifact.id;
                if (artifact.contentType === DOCX_CONTENT_TYPE) await ingestDocx({ ownerId, conversationId, documentId: pdfId, filename: artifact.name, bytes, jobId: responseId, signal: roundSignal, projectId: artifact.projectId, revisionId: artifact.revisionId, parentRevisionId: artifact.parentRevisionId, origin: artifact.origin, editable: artifact.editable, sourceCompleteness: artifact.sourceCompleteness });
                else await ingestPdf({ ownerId, conversationId, pdfId, filename: artifact.name, bytes, jobId: responseId, projectId: artifact.projectId, revisionId: artifact.revisionId, parentRevisionId: artifact.parentRevisionId, origin: artifact.origin, editable: artifact.editable, sourceCompleteness: artifact.sourceCompleteness });
                allowedPdfIds.add(pdfId);
              });
            }
            if (call.name === INSPECT_IMAGE_TOOL_NAME && imageToolAdvertised) {
              return executeInspectImageTool(call, {
                ownerId,
                conversationId,
                allowedImageIds,
                signal: roundSignal,
                responseDeadlineAt,
              });
            }
            if (activeWebTools.some((tool) => tool.function.name === call.name)) return executeWebTool(call, roundSignal);
            if (activeDeepResearchTools.some((tool) => tool.function.name === call.name)) {
              const executed = await executeDeepResearchTool(call, {
                ownerId,
                conversationId,
                jobId: responseId ?? `research-${conversationId}`,
                signal: roundSignal,
                activeRun: activeResearchRun,
              });
              activeResearchRun = executed.activeRun;
              return executed.result;
            }
            if (activeCustomTools.some((tool) => tool.name === call.name) && customToolsByName.has(call.name)) {
              return executeCustomToolCall(call, customToolsByName.get(call.name)!);
            }
            if (activeChatMemoryTools.some((tool) => tool.function.name === call.name)) {
              return executeChatMemoryTool(call, {
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
            }
            if (activeUserMemoryTools.some((tool) => tool.function.name === call.name)) {
              return executeUserMemoryTool(call, {
                ownerId,
                conversationId,
                jobId: responseId ?? `chat-${conversationId}`,
              });
            }
            if (call.name === READ_SKILL_TOOL_NAME && skillTools.length) {
              const result = executeReadSkillTool(call, skillsById);
              if (result.ok) {
                try {
                  const skillId = (JSON.parse(call.arguments) as { skillId?: unknown }).skillId;
                  if (typeof skillId === "string" && skillsById.get(skillId)?.builtinKey === AUTOMATION_SKILL_KEY) automationToolsUnlocked = true;
                  if (typeof skillId === "string" && skillsById.get(skillId)?.builtinKey === CALENDAR_SKILL_KEY) calendarToolsUnlocked = true;
                } catch {}
              }
              return result;
            }
            if (automationDefinitions.some((tool) => tool.function.name === call.name)) return executeAutomationTool(call, ownerId);
            if (calendarDefinitions.some((tool) => tool.function.name === call.name)) return executeCalendarTool(call, ownerId);
            if (automationExecution && call.name === COMPLETE_AUTOMATION_RUN_TOOL_NAME) {
              const completed = executeCompleteAutomationRun(call);
              if (completed.value) executionOptions.onAutomationResult?.(completed.value);
              return completed.result;
            }
            if (todoTools.some((tool) => tool.function.name === call.name)) {
              return executeTodoTool(call, {
                ownerId,
                conversationId,
                onUpdate: async (todos) => enqueue({ type: "todo_update", todos }),
              });
            }
            if (pdfEditTools.some((tool) => tool.function.name === call.name)) {
              if (!isModalConfigured() && call.name !== "inspect_pdf_editability" && call.name !== "compare_document_revisions") throw new Error("PDF editing is not configured.");
              if (!executor && call.name !== "inspect_pdf_editability" && call.name !== "compare_document_revisions") executor = new ModalPythonExecutor(ownerId, conversationId, responseDeadlineAt);
              const result = await executePdfEditTool(call, { ownerId, conversationId, allowedPdfIds, allowedImageIds: new Set(allowedImageIds), allowedProjectIds, executor: executor ?? undefined, jobId: responseId });
              for (const artifact of result.artifacts ?? []) if (artifact.contentType === "application/pdf") allowedPdfIds.add(artifact.id);
              return result;
            }
            if (selected("documents") && availablePdfTools(allowedPdfIds.size > 0).some((tool) => tool.function.name === call.name)) {
              return executePdfTool(call, { ownerId, conversationId, allowedPdfIds });
            }
            if (call.name === SEARCH_CURRENT_CHAT_TOOL_NAME && focusedPlan) return executeCurrentChatContextTool(call, focusedPlan.searchEntries);
            if (call.name === SEARCH_CONNECTOR_TOOLS_NAME && connectorDiscoveryAvailable) {
              const discovered = await executeSearchConnectorTools(call, ownerId);
              discoveredConnectorTools = discovered.tools;
              connectorModelTools = connectorToolsToModelTools(discovered.tools);
              return discovered.result;
            }
            if (call.name.startsWith("connector__") && connectorDiscoveryAvailable) {
              return executeConnectorTool(call, {
                ownerId,
                conversationId,
                jobId: responseId,
                signal: roundSignal,
                onApproval: async (approval) => enqueue({ type: "connector_approval", approval }),
              });
            }
            return {
              id: call.id,
              name: call.name,
              ok: false,
              stdout: "",
              stderr: `Unknown tool: ${call.name}`,
            };
          };

          const indexedCalls = calls.map((call, index) => ({ call, index }));
          const batches = planToolBatches(indexedCalls, ({ call }) =>
            call.name === PHASE_BREAK_TOOL_NAME && activePhaseTools.length
              ? "serial"
              : toolExecutionMetadata(call.name, discoveredConnectorTools).executionPolicy,
          );
          const emitToolResult = async (call: ChatToolCall, result: ChatToolResult): Promise<void> => {
            call.result = result;
            const web = result.web;
            const sources = web?.kind === "search" ? web.results : web?.kind === "page" ? [web.source] : [];
            for (const source of sources) sourceCatalog.set(source.id, source);
            const research = result.research;
            const researchSources = research?.kind === "ledger"
              ? research.sources
              : research?.kind === "page"
                ? [research.page.source]
                : [];
            for (const source of researchSources) sourceCatalog.set(source.id, source);
            await enqueue({ type: "tool_result", result });
            for (const artifact of result.artifacts ?? []) await enqueue({ type: "artifact", artifact });
          };

          for (const batch of batches) {
            const first = batch[0];
            if (batch.length === 1 && first.call.name === PHASE_BREAK_TOOL_NAME && activePhaseTools.length) {
              currentPhase += 1;
              await titleCoordinator.breakPhase(currentPhase);
              const phaseBreak = executePhaseBreak(first.call, currentPhase);
              first.call.result = phaseBreak.result;
              await enqueue({
                type: "phase_break",
                phase: currentPhase,
                ...(phaseBreak.update ? { update: phaseBreak.update } : {}),
                call: first.call,
                result: phaseBreak.result,
              });
              continue;
            }
            for (const { call } of batch) await enqueue({ type: "tool_call", call });
            const settled = await executeToolBatch(
              batch,
              ({ call, index }) => executeToolCall(call, index),
              roundSignal,
            );
            if (roundSignal.aborted) throw roundSignal.reason ?? new Error("The tool batch was cancelled.");
            for (const [{ call }, outcome] of batch.map((item, index) => [item, settled[index]] as const)) {
              const result = outcome.status === "fulfilled"
                ? outcome.value
                : {
                    id: call.id,
                    name: call.name,
                    ok: false,
                    stdout: "",
                    stderr: outcome.reason instanceof Error ? outcome.reason.message : "Tool execution failed.",
                  };
              await emitToolResult(call, result);
            }
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
        await (executor as ModalPythonExecutor | null)?.close().catch(() => undefined);
        if (!signal.aborted) {
          await enqueue({ type: "done", usage: sumRoundUsage(roundUsages) });
        }
      }
}
