import "server-only";

import type { ChatArtifact, ChatAssistantRound, ChatRequest, ChatStreamEvent, ChatToolCall, ChatToolResult, ChatUsage } from "../../lib/chat-protocol";
import type { ChatModelPricing } from "../../lib/chat-model-protocol";
import { chatProviderAdapter } from "../server/chat/chat-provider-registry";
import { authorizeAutomationModel, authorizeChatModel } from "../server/chat/chat-model-catalog-service";
import { availableChatTools, executePythonTool } from "../server/agent/python-tool";
import { runPythonInstructionsFor } from "../server/agent/python-tool-instructions";
import { availableWorkspaceTools } from "../server/agent/workspace-tool-manifest";
import { executeWorkspaceTool } from "../server/agent/workspace-tool";
import { WORKSPACE_TOOL_INSTRUCTIONS } from "../server/agent/workspace-tool-instructions";
import { availableWebTools, executeWebTool } from "../server/agent/web-tools";
import { webToolInstructionsFor } from "../server/agent/web-tool-instructions";
import {
  availableImageTools,
  executeInspectImageTool,
  INSPECT_IMAGE_TOOL_NAME,
} from "../server/agent/image-tool";
import { availableWorkspaceImageTools, INSPECT_WORKSPACE_IMAGE_TOOL_NAME } from "../server/agent/workspace-image-tool-manifest";
import { executeInspectWorkspaceImageTool } from "../server/agent/workspace-image-tool";
import { isLocalPythonConfigured, LocalPythonExecutor } from "../server/python/local-python-executor";
import { getAuthoritativeChatImageIdsForRequest } from "../server/chat/chat-history-store";
import { listAuthorizedProjectImages } from "../server/chat/chat-image-store";
import { latestNonNullUsage, sumRoundUsage } from "./chat-usage";
import { availablePdfTools, executePdfTool } from "../server/agent/pdf-tool";
import { getAuthorizedDocument, getDocumentPages, listAuthorizedProjectDocuments } from "../server/chat/chat-document-store";
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
import { recordPromptUsage } from "../server/usage/prompt-cost-service";
import { TODO_TOOL_DEFINITIONS, executeTodoTool } from "../server/agent/todo-tool";
import { getTodoList } from "../server/chat/chat-todo-store";
import { planTodos } from "../server/chat/chat-todo-planner";
import { appendActiveTodoSystemPrompt } from "../server/chat/chat-todo-prompt";
import { runtimeConfigSnapshot } from "../server/config/runtime-config-service";
import { listOwnerSkills } from "../server/skills/skill-service";
import { skillCatalogInstructions } from "../server/agent/skill-instructions";
import { executeReadSkillTool, executeSkillMutationTool } from "../server/agent/skill-tool";
import { READ_SKILL_TOOL_NAME, SKILL_TOOL_DEFINITIONS, SKILL_TOOL_NAMES } from "../server/agent/skill-tool-manifest";
import { builtinSkillFallbacks } from "../server/skills/builtin-skills";
import { AUTOMATION_SKILL_KEY, AUTOMATION_TOOL_DEFINITIONS, messageUnlocksAutomationTools } from "../server/agent/automation-tool-manifest";
import { executeAutomationTool } from "../server/agent/automation-tool";
import { COMPLETE_AUTOMATION_RUN_TOOL_DEFINITION, COMPLETE_AUTOMATION_RUN_TOOL_NAME, executeCompleteAutomationRun, type AutomationRunResult } from "../server/agent/automation-run-result-tool";
import { availableDeepResearchTools } from "../server/agent/deep-research-tool-manifest";
import { executeDeepResearchTool } from "../server/agent/deep-research-tool";
import { deepResearchInstructionsFor } from "../server/agent/deep-research-tool-instructions";
import { RUN_SUBAGENT_TOOL_NAME, subagentToolDefinition } from "../server/agent/subagent-tool-manifest";
import { executeSubagentTool } from "../server/agent/subagent-tool";
import { SUBAGENT_CHILD_INSTRUCTIONS, SUBAGENT_TOOL_INSTRUCTIONS } from "../server/agent/subagent-tool-instructions";
import type { ResearchRun } from "../server/research/research-types";
import { compileFocusedContext, type FocusedContextPlan, type FocusedToolGroup } from "../server/chat/focused-context";
import {
  CURRENT_CHAT_CONTEXT_TOOL_INSTRUCTIONS,
  currentChatContextToolDefinition,
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
import { calculateChatRunCost, type ChatRunCostInput } from "../../lib/usage-pricing";
import { orchestrateDeepResearch } from "../server/research/deep-research-orchestrator";
import { getProject } from "../server/projects/project-service";
import {
  applyProjectInstructions,
  deepResearchPlanFor,
  isAutomationExecution,
  isSubagentExecution,
  normalizeChatRequestModel,
  stableConversationId,
  type ChatExecutionOptions,
} from "./chat-response-preparation";

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

export async function generateChatResponse(
  chatRequest: ChatRequest,
  ownerId: string,
  signal: AbortSignal,
  persistEvent: (event: ChatStreamEvent) => Promise<void>,
  persistUsage?: (usage: ChatRoundUsage) => Promise<void>,
  persistSummaryUsage?: (usage: ChatSummaryUsage) => Promise<void>,
  executionOptions: ChatExecutionOptions & { onAutomationResult?: (result: AutomationRunResult) => void } = {},
): Promise<{ awaitingApproval: boolean }> {
  const automationExecution = isAutomationExecution(executionOptions);
  const subagentExecution = isSubagentExecution(executionOptions);
  chatRequest = normalizeChatRequestModel(chatRequest);
  if (chatRequest.projectId) {
    const project = await getProject(ownerId, chatRequest.projectId);
    if (!project) throw new Error("The requested project is not available.");
    chatRequest = applyProjectInstructions(chatRequest, project.instructions);
  }
  const selectedMetadata = await (automationExecution ? authorizeAutomationModel(ownerId, chatRequest.model) : authorizeChatModel(ownerId, chatRequest.model));
  const providerAdapter = chatProviderAdapter(chatRequest.model.provider);
  providerAdapter.assertConfigured();
  const responseDeadlineAt = Date.now() + MAX_RESPONSE_MS;
  const responseId = chatRequest.jobId;
  const conversationId = stableConversationId(chatRequest);
  const latestPreviousAssistant = [...chatRequest.messages].reverse().find((message) => message.role === "assistant")?.content;
  const pythonTools = availableChatTools();
  const workspaceTools = availableWorkspaceTools(isLocalPythonConfigured());
  const webTools = availableWebTools();
  const requestedPdfIds = [...new Set(chatRequest.messages.flatMap((message) => message.documents?.map((item) => item.id) ?? []))];
  const [
    consolidatedMemory,
    currentTodos,
    customTools,
    skills,
    allowedImageIds,
    authorizedDocuments,
    projectDocuments,
    projectImages,
    connectorCatalog,
  ] = await Promise.all([
    automationExecution ? Promise.resolve("") : getConsolidatedPrompt(ownerId).catch(() => "").then(formatConsolidatedPrompt),
    automationExecution || subagentExecution ? Promise.resolve({ revision: 0, items: [] }) : getTodoList(ownerId, conversationId).catch(() => ({ revision: 0, items: [] })),
    isLocalPythonConfigured()
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
    chatRequest.projectId ? listAuthorizedProjectDocuments(ownerId, conversationId) : Promise.resolve([]),
    chatRequest.projectId ? listAuthorizedProjectImages(ownerId, conversationId) : Promise.resolve([]),
    !automationExecution ? listConnectorCatalog(ownerId, { refreshLocalDriveTools: false }).catch((error) => {
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
  for (const document of projectDocuments) {
    allowedPdfIds.add(document.id);
    authoritativePdfs.set(document.id, document);
  }
  const availableProjectImageIds = projectImages.map((image) => image.id);
  const visibleImageIds = [...new Set([...allowedImageIds, ...availableProjectImageIds])];
  const imageTools = availableImageTools(visibleImageIds.length > 0);
  const workspaceImageTools = availableWorkspaceImageTools(isLocalPythonConfigured());
  const allPdfEditTools = availablePdfEditTools([...authoritativePdfs.values()].some((document) => document.contentType === "application/pdf"));
  const allPdfReadTools = availablePdfTools(allowedPdfIds.size > 0, [...authoritativePdfs.values()].some((document) => document.contentType === "application/pdf"));
  const phaseTools = chatRequest.thinking && !automationExecution ? [PHASE_BREAK_TOOL_DEFINITION] : [];
  const latestMessage = chatRequest.messages.at(-1);
  const latestUserMessage = [...chatRequest.messages].reverse().find((message) => message.role === "user");
  const automationKeywordUnlock = !automationExecution && chatRequest.messages.some(
    (message) => message.role === "user" && messageUnlocksAutomationTools(message.content),
  );
  const calendarKeywordUnlock = messageUnlocksCalendarTools(latestUserMessage?.content ?? "");
  const connectorDiscoveryAvailable = connectorCatalog.some((connector) => connector.installed && connector.connections.some((connection) => connection.status === "connected"));
  const potentialDeepResearchTools = automationExecution || subagentExecution ? [] : availableDeepResearchTools(true);
  const potentialTodoTools = automationExecution || subagentExecution ? [] : TODO_TOOL_DEFINITIONS;
  const toolGroups: FocusedToolGroup[] = [
    ...(pythonTools.length ? [{ id: "python", summary: "Run Python for computation, data processing, or generated files.", keywords: ["python", "calculate", "compute", "chart", "spreadsheet", "generate file"], fallback: true }] : []),
    ...(workspaceTools.length ? [{ id: "workspace", summary: "Inspect, create, edit, search, and run checks against persistent conversation files.", keywords: ["file", "files", "code", "html", "javascript", "typescript", "python", "edit", "create", "write", "workspace", "script"], fallback: true }] : []),
    ...(imageTools.length ? [{ id: "image", summary: "Inspect an attached image.", keywords: ["image", "photo", "picture", "screenshot"], required: Boolean(latestMessage?.attachments?.length) }] : []),
    ...(workspaceImageTools.length ? [{ id: "workspace-image", summary: "Inspect an image file in the persistent workspace, including one imported from Local Drive.", keywords: ["workspace image", "local drive image", "drive photo", "image file", "photo file", "describe image"], fallback: true }] : []),
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
  const plannerPromise = automationExecution || subagentExecution ? Promise.resolve({ list: null, plannedThisTurn: false }) : planTodos({
    ownerId,
    conversationId,
    userMessage: chatRequest.messages.at(-1)?.content ?? "",
    previousAssistantOutput: latestPreviousAssistant,
    current: currentTodos,
    signal,
    onUsage: async (answer) => {
      await recordPromptUsage({
        ownerId,
        provider: "openrouter",
        model: answer.model,
        requestKind: "todo_planner",
        requestId: responseId ?? `todo-${conversationId}`,
        round: 0,
        usage: answer.usage ?? answer.estimatedUsage,
        source: answer.usage || answer.exactCostUsd !== undefined ? "exact" : "estimated",
        exactCostUsd: answer.exactCostUsd,
        unpriced: answer.exactCostUsd === undefined,
        conversationId,
        jobId: responseId,
      }).catch(() => undefined);
    },
  });
  const focusedPlanPromise: Promise<FocusedContextPlan | null> = !automationExecution && !subagentExecution && chatRequest.contextMode === "focused"
    ? compileFocusedContext({
      messages: chatRequest.messages,
      toolGroups,
      signal,
      onRouterUsage: async ({ model, usage, estimated, exactCostUsd }) => {
        await recordPromptUsage({
          ownerId,
          provider: "openrouter",
          model,
          requestKind: "context_router",
          requestId: responseId ?? `context-${conversationId}`,
          round: 0,
          usage,
          source: !estimated || exactCostUsd !== undefined ? "exact" : "estimated",
          exactCostUsd,
          unpriced: exactCostUsd === undefined,
          conversationId,
          jobId: responseId,
        }).catch(() => undefined);
      },
    })
    : Promise.resolve(null);
  const [planner, focusedPlan] = await Promise.all([plannerPromise, focusedPlanPromise]);
  chatRequest = {
    ...chatRequest,
    systemPrompt: appendActiveTodoSystemPrompt(chatRequest.systemPrompt, planner.list ?? currentTodos),
  };
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
  const deepResearchTools = !automationExecution && !subagentExecution && planner.plannedThisTurn && Boolean(planner.list?.items.length)
    ? potentialDeepResearchTools
    : [];
  const selected = (group: string) => !focusedPlan || focusedPlan.selectedToolGroups.has(group);
  const activePythonTools = selected("python") ? pythonTools : [];
  const activeWorkspaceTools = selected("workspace") ? workspaceTools : [];
  const activeImageTools = selected("image") ? imageTools : [];
  const activeWorkspaceImageTools = selected("workspace-image") ? workspaceImageTools : [];
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
  const contextTools = focusedPlan?.searchEntries.length ? [currentChatContextToolDefinition()] : [];
  const configuration = runtimeConfigSnapshot();
  const documentContextLimits = { maxInlineTokens: configuration.documentInlineMaxTokens, maxInlinePages: configuration.documentInlineMaxPages };
  const pagesForInlineDocument = createInlineDocumentPageLoader((document) => getDocumentPages(ownerId, conversationId, document.id), documentContextLimits);
  const contextualMessages = await Promise.all(chatRequest.messages.map(async (message) => {
    const documents = (message.documents ?? []).filter((item) => allowedPdfIds.has(item.id));
    if (!documents.length) return message;
    const contexts = await Promise.all(documents.map(async ({ id }) => {
      const document = authoritativePdfs.get(id)!;
      return documentContext(document, await pagesForInlineDocument(document), documentContextLimits);
    }));
    return { ...message, content: `${message.content}\n\n${contexts.join("\n\n")}` };
  }));
  chatRequest = { ...chatRequest, messages: contextualMessages };
  const allowedProjectIds = new Set([...authoritativePdfs.values()].map((document) => document.projectId).filter((projectId): projectId is string => Boolean(projectId)));
  const baseToolDefinitions = [...activePythonTools, ...activeWorkspaceTools, ...activeImageTools, ...activeWorkspaceImageTools, ...activeWebTools, ...activeDeepResearchTools, ...pdfEditTools, ...activePhaseTools, ...customDefinitions, ...activeChatMemoryTools, ...activeUserMemoryTools, ...skillTools, ...todoTools, ...automationResultTools, ...contextTools, ...(connectorDiscoveryAvailable && selected("connectors") ? [SEARCH_CONNECTOR_TOOLS_DEFINITION] : []), ...(subagentExecution ? [] : [subagentToolDefinition()])];
  const imageToolAdvertised = activeImageTools.some((tool) => tool.function.name === INSPECT_IMAGE_TOOL_NAME);

  const enqueue = async (event: ChatStreamEvent) => {
    if (!signal.aborted) await persistEvent(event);
  };
  if (!automationExecution && chatRequest.mode === "deep_research") {
    const request = chatRequest.messages.at(-1)?.content ?? "";
    const plan = chatRequest.deepResearchPlan ?? deepResearchPlanFor(request, planner.list?.items.map((item) => ({ id: item.id, text: item.text })) ?? []);
    if (chatRequest.deepResearchPhase !== "execute") {
      if (planner.list) await enqueue({ type: "todo_update", todos: planner.list });
      await enqueue({ type: "deep_research_plan", plan });
      await enqueue({ type: "done", usage: null });
      return { awaitingApproval: true };
    }
    await enqueue({ type: "deep_research_plan", plan });
    const result = await orchestrateDeepResearch({
      ownerId,
      conversationId,
      jobId: responseId ?? `research-${conversationId}`,
      request,
      plan,
      signal,
      onOrchestratorUpdate: async ({ status, reasoningDelta, summary, summaryRevision, trace }) => enqueue({
        type: "deep_research_orchestrator_update",
        status,
        ...(reasoningDelta ? { reasoningDelta } : {}),
        ...(summary ? { summary } : {}),
        ...(summaryRevision === undefined ? {} : { summaryRevision }),
        ...(trace ? { trace } : {}),
      }),
      onSubagentUpdate: async ({ task, status, summary, summaryRevision, trace }) => enqueue({
        type: "subagent_update",
        mode: "research",
        taskId: task.id,
        title: task.title,
        status,
        ...(summary ? { summary } : {}),
        ...(summaryRevision === undefined ? {} : { summaryRevision }),
        ...(trace ? { trace } : {}),
      }),
    });
    await enqueue({ type: "content", delta: result.report });
    await enqueue({ type: "annotations", annotations: [], sources: result.sources });
    await enqueue({ type: "done", usage: null });
    return { awaitingApproval: false };
  }
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
      const roundCostInputs: Array<ChatRunCostInput | null> = [];
      const subagentCostInputs: ChatRunCostInput[] = [];
      let executor: LocalPythonExecutor | null = null;
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
            ? activePdfReadTools.filter((tool) => !baseToolDefinitions.some((base) => base.function.name === tool.function.name))
            : [];
          const dynamicConnectorTools = selected("connectors") ? connectorModelTools : [];
          const toolDefinitions = [...baseToolDefinitions, ...automationDefinitions, ...calendarDefinitions, ...dynamicPdfTools, ...dynamicConnectorTools];

          const runDelegatedTask = async (
            input: { task: string; context?: string; callId: string; signal: AbortSignal },
            onEvent?: (event: ChatStreamEvent) => Promise<void> | void,
          ) => {
            const childJobId = `${responseId ?? `chat-${conversationId}`}:subagent:${input.callId}`;
            const childSourceCatalog = new Map<string, ChatSource>();
            const childArtifacts: ChatArtifact[] = [];
            const childErrors: string[] = [];
            let childOutput = "";

            const recordChildRoundUsage = async (usage: ChatRoundUsage): Promise<void> => {
              const recordedUsage = usage.usage ?? usage.estimatedUsage;
              if (!recordedUsage) return;
              subagentCostInputs.push({
                usage: recordedUsage,
                ...(usage.exactCostUsd === undefined ? {} : { exactCostUsd: usage.exactCostUsd }),
                pricing: usage.pricing,
              });
              await recordPromptUsage({
                ownerId,
                provider: usage.provider,
                model: usage.model,
                requestKind: "subagent",
                requestId: childJobId,
                round: usage.round,
                usage: recordedUsage,
                source: usage.usage || usage.exactCostUsd !== undefined ? "exact" : "estimated",
                exactCostUsd: usage.exactCostUsd,
                pricingSnapshot: usage.pricing ? {
                  provider: usage.provider,
                  model: usage.model,
                  label: usage.model,
                  inputUsdPerMillion: usage.pricing.inputUsdPerMillion,
                  cachedInputUsdPerMillion: usage.pricing.cachedInputUsdPerMillion,
                  outputUsdPerMillion: usage.pricing.outputUsdPerMillion,
                  requestUsd: usage.pricing.requestUsd,
                  reasoningUsdPerMillion: usage.pricing.reasoningUsdPerMillion,
                } : null,
                unpriced: usage.exactCostUsd === undefined && (!usage.pricing || usage.pricing.inputUsdPerMillion === null || usage.pricing.outputUsdPerMillion === null || ((usage.usage?.reasoningTokens ?? usage.estimatedUsage?.reasoningTokens ?? 0) > 0 && usage.pricing.reasoningUsdPerMillion === null)),
                conversationId,
                jobId: responseId ?? childJobId,
              }).catch(() => undefined);
            };

            const recordChildSummaryUsage = async (usage: ChatSummaryUsage): Promise<void> => {
              const recordedUsage = usage.usage ?? usage.estimatedUsage;
              if (!recordedUsage) return;
              const round = 2_000_000 + usage.phase * 100_000 + usage.revision;
              subagentCostInputs.push({
                usage: recordedUsage,
                ...(usage.exactCostUsd === undefined ? {} : { exactCostUsd: usage.exactCostUsd }),
                pricing: null,
              });
              await recordPromptUsage({
                ownerId,
                provider: usage.provider,
                model: usage.model,
                requestKind: "subagent",
                requestId: childJobId,
                round,
                usage: recordedUsage,
                source: usage.usage || usage.exactCostUsd !== undefined ? "exact" : "estimated",
                exactCostUsd: usage.exactCostUsd,
                unpriced: usage.exactCostUsd === undefined,
                conversationId,
                jobId: responseId ?? childJobId,
              }).catch(() => undefined);
            };

            const childRequest: ChatRequest = {
              ...chatRequest,
              messages: [
                ...chatRequest.messages,
                {
                  role: "user",
                  content: [
                    "<delegated_task>",
                    input.task,
                    "</delegated_task>",
                    ...(input.context ? ["<delegated_context>", input.context, "</delegated_context>"] : []),
                    "Return concise findings for the parent agent, including relevant file paths, source links, uncertainty, and verified artifacts where applicable.",
                  ].join("\n"),
                },
              ],
              mode: "normal",
              deepResearchPhase: undefined,
              deepResearchPlan: undefined,
              contextMode: "full",
              conversationId,
              jobId: childJobId,
              idempotencyKey: childJobId,
              persistence: undefined,
            };

            const rememberSources = (result: ChatToolResult): void => {
              const web = result.web;
              const webSources = web?.kind === "search" ? web.results : web?.kind === "page" ? [web.source] : [];
              for (const source of webSources) childSourceCatalog.set(source.id, source);
              const research = result.research;
              const researchSources = research?.kind === "ledger"
                ? research.sources
                : research?.kind === "page"
                  ? [research.page.source]
                  : [];
              for (const source of researchSources) childSourceCatalog.set(source.id, source);
              for (const source of result.subagent?.sources ?? []) childSourceCatalog.set(source.id, source);
            };

            await generateChatResponse(
              childRequest,
              ownerId,
              input.signal,
              async (event) => {
                if (event.type === "content") childOutput += event.delta;
                if (event.type === "error") childErrors.push(event.message);
                if (event.type === "tool_result") rememberSources(event.result);
                if (event.type === "annotations") for (const source of event.sources) childSourceCatalog.set(source.id, source);
                if (event.type === "artifact") childArtifacts.push(event.artifact);
                await onEvent?.(event);
              },
              recordChildRoundUsage,
              recordChildSummaryUsage,
              { profile: "subagent", subagentDepth: (executionOptions.subagentDepth ?? 0) + 1 },
            );

            const stdout = childOutput.trim();
            const stderr = childErrors.join("\n").slice(0, 4_000);
            return {
              ok: childErrors.length === 0,
              stdout: stdout || (stderr ? "" : "Delegated task completed without a textual summary."),
              ...(stderr ? { stderr } : {}),
              ...(childArtifacts.length ? { artifacts: [...new Map(childArtifacts.map((artifact) => [artifact.id, artifact])).values()].slice(0, Math.min(configuration.subagentMaxArtifacts, 100)) } : {}),
              sources: validCitationSources([...childSourceCatalog.values()]).slice(0, Math.min(configuration.subagentMaxSources, 200)),
            };
          };
          await enqueue({ type: "round", round });
          const systemInstructions = [
            ...runPythonInstructionsFor(Boolean(activePythonTools.length)),
            ...(activeWorkspaceTools.length || activeWorkspaceImageTools.length ? [WORKSPACE_TOOL_INSTRUCTIONS] : []),
            ...webToolInstructionsFor(Boolean(activeWebTools.length)),
            ...deepResearchInstructionsFor(Boolean(activeDeepResearchTools.length)),
            ...(subagentExecution ? [SUBAGENT_CHILD_INSTRUCTIONS] : [SUBAGENT_TOOL_INSTRUCTIONS]),
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
            ...(projectDocuments.length ? [
              `<project-files>\nShared project documents are available to this project chat. Use the document tools with the matching documentId when a project file is relevant:\n${projectDocuments.map((document) => `- ${document.name} (documentId: ${document.id})`).join("\n")}\n</project-files>`,
            ] : []),
            ...(projectImages.length ? [
              `<project-images>\nShared project images are available to this project chat. Use inspect_image with the matching imageId when a project image is relevant:\n${projectImages.map((image) => `- ${image.name ?? "image"} (imageId: ${image.id})`).join("\n")}\n</project-images>`,
            ] : []),
            RESPONSE_STYLE_INSTRUCTIONS,
          ];
          const reasoningParts: string[] = [];
          const contentParts: string[] = [];
          const citationFilter = new IncrementalCitationFilter();
          const calls: ChatToolCall[] = [];
          const reasoningDetails: unknown[] = [];
          const roundUsageIndex = roundUsages.push(null) - 1;
          roundCostInputs.push(null);
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
              const roundUsage = {
                round,
                usage: providerUsage,
                ...(estimatedUsage ? { estimatedUsage } : {}),
                provider: chatRequest.model.provider,
                model: actualModel,
                ...(exactCostUsd === undefined ? {} : { exactCostUsd }),
                pricing,
              } satisfies ChatRoundUsage;
              roundCostInputs[roundUsageIndex] = {
                usage: providerUsage ?? estimatedUsage,
                ...(exactCostUsd === undefined ? {} : { exactCostUsd }),
                pricing,
              };
              if (persistUsage) await persistUsage(roundUsage);
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
            if (activeWorkspaceTools.some((tool) => tool.function.name === call.name)) {
              if (!isLocalPythonConfigured()) throw new Error("Workspace tools are not configured.");
              if (!executor) executor = new LocalPythonExecutor(ownerId, conversationId, responseDeadlineAt).withWorkspaceId(chatRequest.projectId ?? conversationId);
              return executeWorkspaceTool(call, { ownerId, conversationId, projectId: chatRequest.projectId, executor });
            }
            if (call.name === "run_python" && activePythonTools.length) {
              if (!isLocalPythonConfigured()) throw new Error("Python execution is not configured.");
              if (!executor) executor = new LocalPythonExecutor(ownerId, conversationId, responseDeadlineAt).withWorkspaceId(chatRequest.projectId ?? conversationId);
              return executePythonTool(call, executor, ownerId, conversationId, async (artifact, bytes, storageObjectId) => {
                const pdfId = artifact.id;
                if (artifact.contentType === DOCX_CONTENT_TYPE) await ingestDocx({ ownerId, conversationId, documentId: pdfId, filename: artifact.name, bytes, storageObjectId, alreadyUploaded: true, jobId: responseId, signal: roundSignal, projectId: artifact.projectId, revisionId: artifact.revisionId, parentRevisionId: artifact.parentRevisionId, origin: artifact.origin, editable: artifact.editable, sourceCompleteness: artifact.sourceCompleteness });
                else await ingestPdf({ ownerId, conversationId, pdfId, filename: artifact.name, bytes, storageObjectId, alreadyUploaded: true, jobId: responseId, projectId: artifact.projectId, revisionId: artifact.revisionId, parentRevisionId: artifact.parentRevisionId, origin: artifact.origin, editable: artifact.editable, sourceCompleteness: artifact.sourceCompleteness });
                allowedPdfIds.add(pdfId);
              }, {}, chatRequest.projectId);
            }
            if (call.name === INSPECT_IMAGE_TOOL_NAME && imageToolAdvertised) {
              return executeInspectImageTool(call, {
                ownerId,
                conversationId,
                allowedImageIds: visibleImageIds,
                jobId: responseId,
                signal: roundSignal,
                responseDeadlineAt,
              });
            }
            if (call.name === INSPECT_WORKSPACE_IMAGE_TOOL_NAME && activeWorkspaceImageTools.some((tool) => tool.function.name === call.name)) {
              if (!isLocalPythonConfigured()) throw new Error("Workspace image inspection is not configured.");
              if (!executor) executor = new LocalPythonExecutor(ownerId, conversationId, responseDeadlineAt).withWorkspaceId(chatRequest.projectId ?? conversationId);
              return executeInspectWorkspaceImageTool(call, {
                ownerId,
                conversationId,
                jobId: responseId,
                signal: roundSignal,
                responseDeadlineAt,
                executor,
              });
            }
            if (call.name === RUN_SUBAGENT_TOOL_NAME && !subagentExecution) {
              return executeSubagentTool(call, {
                signal: roundSignal,
                run: runDelegatedTask,
                onUpdate: async ({ taskId, title, status, summary }) => enqueue({
                  type: "subagent_update",
                  mode: "tool",
                  taskId,
                  title,
                  status,
                  ...(summary ? { summary } : {}),
                }),
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
                onRecallUsage: async ({ model, usage, source, exactCostUsd }) => {
                  await recordPromptUsage({
                    ownerId,
                    provider: "openrouter",
                    model,
                    requestKind: "chat_recall",
                    requestId: responseId ?? `chat-${conversationId}`,
                    round: round * 10_000 + callIndex,
                    usage,
                    source,
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
            if ((call.name === SKILL_TOOL_NAMES.create || call.name === SKILL_TOOL_NAMES.update) && skillTools.length) {
              return executeSkillMutationTool(call, ownerId);
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
              if (!isLocalPythonConfigured() && call.name !== "inspect_pdf_editability" && call.name !== "compare_document_revisions") throw new Error("Python execution is not configured.");
              if (!executor && call.name !== "inspect_pdf_editability" && call.name !== "compare_document_revisions") executor = new LocalPythonExecutor(ownerId, conversationId, responseDeadlineAt).withWorkspaceId(chatRequest.projectId ?? conversationId);
              const result = await executePdfEditTool(call, { ownerId, conversationId, allowedPdfIds, allowedImageIds: new Set(visibleImageIds), allowedProjectIds, executor: executor ?? undefined, jobId: responseId });
              for (const artifact of result.artifacts ?? []) if (artifact.contentType === "application/pdf") allowedPdfIds.add(artifact.id);
              return result;
            }
            if (selected("documents") && allPdfReadTools.some((tool) => tool.function.name === call.name)) {
              return executePdfTool(call, { ownerId, conversationId, allowedPdfIds, jobId: responseId, signal: roundSignal });
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
                workspace: isLocalPythonConfigured()
                  ? {
                      writeStream: async (path, source, size, options) => {
                        if (!executor) executor = new LocalPythonExecutor(ownerId, conversationId, responseDeadlineAt).withWorkspaceId(chatRequest.projectId ?? conversationId);
                        return executor.writeWorkspaceStream(path, source, size, options);
                      },
                    }
                  : undefined,
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
            for (const source of result.subagent?.sources ?? []) sourceCatalog.set(source.id, source);
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
        await (executor as LocalPythonExecutor | null)?.close().catch(() => undefined);
        if (!signal.aborted) {
          await enqueue({
            type: "done",
            usage: sumRoundUsage(roundUsages),
            runCost: calculateChatRunCost([
              ...roundCostInputs.flatMap((input) => input ? [input] : []),
              ...subagentCostInputs,
            ]),
          });
        }
      }
      return { awaitingApproval: false };
}
