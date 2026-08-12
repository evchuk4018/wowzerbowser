export type RuntimeConfigValue = boolean | number | string | string[];

export type RuntimeConfigKey =
  | "searchStackEnabled"
  | "chatResponseTimeoutMs"
  | "webSearchMaxResultsGeneral"
  | "webSearchMaxResultsNews"
  | "webSearchMaxResultsCommunity"
  | "webSearchMaxResultsReference"
  | "webFetchMaxMarkdownCharacters"
  | "searchProviderRequestTimeoutMs"
  | "searchProviderMaxAttempts"
  | "searchProviderRetryDelayMs"
  | "searchProviderMinIntervalMs"
  | "searxngUrl"
  | "searxngFormats"
  | "searxngLimiter"
  | "searxngPublicInstance"
  | "minifluxUrl"
  | "firecrawlUrl"
  | "opendataloaderHybridUrl"
  | "pythonWorkerUrl"
  | "pipedreamConnectBaseUrl"
  | "deploymentLocation"
  | "searchProviderCacheTtlMs"
  | "searchProviderFailureThreshold"
  | "searchProviderCircuitOpenMs"
  | "firecrawlMaxConcurrentPages"
  | "firecrawlMaxConcurrentJobs"
  | "firecrawlBrowserPoolSize"
  | "deepResearchMaxSearches"
  | "deepResearchMaxFetchedPages"
  | "deepResearchMaxFollowUpSearches"
  | "deepResearchMaxEvidenceTokens"
  | "deepResearchMaxModelCalls"
  | "deepResearchMaxEstimatedCostUsd"
  | "deepResearchMaxPagesPerDomain"
  | "deepResearchQueryPlannerMaxOutputTokens"
  | "deepResearchQueryPlannerTimeoutMs"
  | "deepResearchClaimMaxOutputTokens"
  | "deepResearchClaimTimeoutMs"
  | "deepResearchSynthesisMaxOutputTokens"
  | "deepResearchSynthesisTimeoutMs"
  | "deepResearchMaxEvidenceCharacters"
  | "deepResearchMaxSourcesPerFinding"
  | "deepResearchMaxClaims"
  | "deepResearchMaxSubagentConcurrency"
  | "deepResearchFindInPageMaxResults"
  | "deepResearchMaxPageLinks"
  | "deepResearchPageOutputCharacters"
  | "chatDurableSummariesEnabled"
  | "userMemoryDreamingEnabled"
  | "focusedContextRecentTurns"
  | "focusedContextMaxOlderTurns"
  | "focusedContextMaxHistoryCharacters"
  | "focusedContextRouterTimeoutMs"
  | "focusedContextRouterMaxTokens"
  | "focusedContextIndexExcerptCharacters"
  | "currentChatSearchDefaultResults"
  | "currentChatSearchMaxResults"
  | "currentChatSearchMaxOutputCharacters"
  | "chatHistorySearchMaxResults"
  | "chatMemoryContextMaxCharacters"
  | "chatMemoryRecallMaxPromptCharacters"
  | "chatMemoryRecallMaxOutputTokens"
  | "chatMemoryRecallTimeoutMs"
  | "chatSummaryMaxOutputTokens"
  | "chatSummaryTimeoutMs"
  | "chatSummaryMaxAttempts"
  | "chatTitleMaxOutputTokens"
  | "chatTitleTimeoutMs"
  | "reasoningSummaryMaxOutputTokens"
  | "reasoningSummaryTimeoutMs"
  | "todoPlannerMaxPromptCharacters"
  | "todoPlannerMaxOutputTokens"
  | "todoPlannerTimeoutMs"
  | "todoPlannerMaxAttempts"
  | "documentInlineMaxTokens"
  | "documentInlineMaxPages"
  | "pdfSearchMaxResults"
  | "pdfReadMaxPages"
  | "imageAnalysisMaxResponseCharacters"
  | "imageFollowupMaxQuestionCharacters"
  | "documentImageAnalysisMaxStoredCharacters"
  | "workspaceSearchDefaultResults"
  | "workspaceSearchMaxResults"
  | "workspaceMaxReadOutputCharacters"
  | "workspaceMaxSearchFileBytes"
  | "workspaceMaxCommandOutputCharacters"
  | "connectorSearchMaxResults"
  | "subagentMaxTaskCharacters"
  | "subagentMaxContextCharacters"
  | "subagentMaxOutputCharacters"
  | "subagentMaxSources"
  | "subagentMaxArtifacts"
  | "pdfOcrConcurrency"
  | "pdfImageAnalysisConcurrency"
  | "workerPollIntervalMs"
  | "workerHeartbeatIntervalMs"
  | "workerHeartbeatMaxAgeMs"
  | "storageMaintenanceIntervalMs"
  | "automationSchedulerIntervalMs"
  | "automationSchedulerBatch"
  | "memorySchedulerIntervalMs"
  | "workerMaintenanceLimit"
  | "workerChatConcurrency"
  | "workerDocumentConcurrency"
  | "workerImageConcurrency"
  | "workerOcrConcurrency"
  | "discordProcessingIntervalMs";

export type RuntimeConfigValues = {
  [key in RuntimeConfigKey]: RuntimeConfigValueForKey<key>;
};

export type RuntimeConfigValueForKey<Key extends RuntimeConfigKey> =
  Key extends "searchStackEnabled" | "searxngLimiter" | "searxngPublicInstance" | "chatDurableSummariesEnabled" | "userMemoryDreamingEnabled"
    ? boolean
    : Key extends "searxngFormats"
      ? string[]
      : Key extends "deepResearchMaxEstimatedCostUsd"
        ? number
        : Key extends "deploymentLocation" | "searxngUrl" | "minifluxUrl" | "firecrawlUrl" | "opendataloaderHybridUrl" | "pythonWorkerUrl" | "pipedreamConnectBaseUrl"
          ? string
          : number;

export type RuntimeConfigFieldType = "boolean" | "integer" | "number" | "text" | "url" | "list";

export type RuntimeConfigDescriptor = {
  key: RuntimeConfigKey;
  label: string;
  description: string;
  category: "search" | "chat" | "providers" | "research" | "documents" | "agent" | "worker" | "memory";
  type: RuntimeConfigFieldType;
  envName?: string;
  defaultValue: RuntimeConfigValue;
  minimum?: number;
  maximum?: number;
  restartRequired: boolean;
};

export type RuntimeConfigResponse = {
  values: RuntimeConfigValues;
  descriptors: RuntimeConfigDescriptor[];
  updatedAt: string | null;
  restartRequired: boolean;
  restartRequiredKeys: RuntimeConfigKey[];
};

const descriptor = <Key extends RuntimeConfigKey>(input: RuntimeConfigDescriptor & { key: Key; defaultValue: RuntimeConfigValueForKey<Key> }): RuntimeConfigDescriptor => input;

export const RUNTIME_CONFIG_DESCRIPTORS: RuntimeConfigDescriptor[] = [
  descriptor({ key: "searchStackEnabled", label: "Search stack enabled", description: "Make the self-hosted web search tools available to the assistant.", category: "search", type: "boolean", envName: "SEARCH_STACK_ENABLED", defaultValue: false, restartRequired: false }),
  descriptor({ key: "chatResponseTimeoutMs", label: "Chat response timeout", description: "Maximum wall-clock time for an interactive response, including tool and delegated work.", category: "chat", type: "integer", envName: "CHAT_RESPONSE_TIMEOUT_MS", defaultValue: 500_000, minimum: 60_000, maximum: 3_600_000, restartRequired: false }),
  descriptor({ key: "webSearchMaxResultsGeneral", label: "Web results: general", description: "Maximum results returned for a general web search.", category: "search", type: "integer", envName: "WEB_SEARCH_MAX_RESULTS_GENERAL", defaultValue: 20, minimum: 1, maximum: 50, restartRequired: false }),
  descriptor({ key: "webSearchMaxResultsNews", label: "Web results: news", description: "Maximum results returned for a news-focused web search.", category: "search", type: "integer", envName: "WEB_SEARCH_MAX_RESULTS_NEWS", defaultValue: 20, minimum: 1, maximum: 50, restartRequired: false }),
  descriptor({ key: "webSearchMaxResultsCommunity", label: "Web results: community", description: "Maximum results returned for a community-focused web search.", category: "search", type: "integer", envName: "WEB_SEARCH_MAX_RESULTS_COMMUNITY", defaultValue: 20, minimum: 1, maximum: 50, restartRequired: false }),
  descriptor({ key: "webSearchMaxResultsReference", label: "Web results: reference", description: "Maximum results returned for a reference-focused web search.", category: "search", type: "integer", envName: "WEB_SEARCH_MAX_RESULTS_REFERENCE", defaultValue: 20, minimum: 1, maximum: 50, restartRequired: false }),
  descriptor({ key: "webFetchMaxMarkdownCharacters", label: "Fetched page output", description: "Maximum Markdown characters returned to the assistant from one web page.", category: "search", type: "integer", envName: "WEB_FETCH_MAX_MARKDOWN_CHARACTERS", defaultValue: 24_000, minimum: 4_000, maximum: 80_000, restartRequired: false }),
  descriptor({ key: "searchProviderRequestTimeoutMs", label: "Search request timeout", description: "How long an individual search-provider request may run.", category: "search", type: "integer", envName: "SEARCH_PROVIDER_REQUEST_TIMEOUT_MS", defaultValue: 12_000, minimum: 1_000, maximum: 60_000, restartRequired: false }),
  descriptor({ key: "searchProviderMaxAttempts", label: "Search retry attempts", description: "Maximum attempts for a search-provider request, including the first attempt.", category: "search", type: "integer", envName: "SEARCH_PROVIDER_MAX_ATTEMPTS", defaultValue: 2, minimum: 1, maximum: 4, restartRequired: false }),
  descriptor({ key: "searchProviderRetryDelayMs", label: "Search retry delay", description: "Delay between transient search-provider attempts in milliseconds.", category: "search", type: "integer", envName: "SEARCH_PROVIDER_RETRY_DELAY_MS", defaultValue: 25, minimum: 0, maximum: 5_000, restartRequired: false }),
  descriptor({ key: "searchProviderMinIntervalMs", label: "Search request spacing", description: "Minimum spacing between starts of requests to the self-hosted SearXNG provider.", category: "search", type: "integer", envName: "SEARCH_PROVIDER_MIN_INTERVAL_MS", defaultValue: 1_000, minimum: 0, maximum: 10_000, restartRequired: false }),
  descriptor({ key: "focusedContextRecentTurns", label: "Recent chat turns", description: "Number of recent conversation turns always included in the assistant context.", category: "chat", type: "integer", envName: "FOCUSED_CONTEXT_RECENT_TURNS", defaultValue: 2, minimum: 1, maximum: 8, restartRequired: false }),
  descriptor({ key: "focusedContextMaxOlderTurns", label: "Older chat turns", description: "Maximum additional older turns selected for the current request.", category: "chat", type: "integer", envName: "FOCUSED_CONTEXT_MAX_OLDER_TURNS", defaultValue: 4, minimum: 0, maximum: 12, restartRequired: false }),
  descriptor({ key: "focusedContextMaxHistoryCharacters", label: "Chat context size", description: "Maximum serialized conversation characters included after focused context selection.", category: "chat", type: "integer", envName: "FOCUSED_CONTEXT_MAX_HISTORY_CHARACTERS", defaultValue: 96_000, minimum: 8_000, maximum: 250_000, restartRequired: false }),
  descriptor({ key: "focusedContextRouterTimeoutMs", label: "Context router timeout", description: "Maximum time for the model that selects older turns and tool groups.", category: "chat", type: "integer", envName: "FOCUSED_CONTEXT_ROUTER_TIMEOUT_MS", defaultValue: 5_000, minimum: 500, maximum: 30_000, restartRequired: false }),
  descriptor({ key: "focusedContextRouterMaxTokens", label: "Context router tokens", description: "Maximum output tokens for focused-context selection.", category: "chat", type: "integer", envName: "FOCUSED_CONTEXT_ROUTER_MAX_TOKENS", defaultValue: 300, minimum: 32, maximum: 2_000, restartRequired: false }),
  descriptor({ key: "focusedContextIndexExcerptCharacters", label: "Context index excerpt", description: "Characters retained per older turn in the focused-context index.", category: "chat", type: "integer", envName: "FOCUSED_CONTEXT_INDEX_EXCERPT_CHARACTERS", defaultValue: 350, minimum: 100, maximum: 2_000, restartRequired: false }),
  descriptor({ key: "currentChatSearchDefaultResults", label: "Current-chat search results", description: "Default number of matching older turns returned by current-chat search.", category: "chat", type: "integer", envName: "CURRENT_CHAT_SEARCH_DEFAULT_RESULTS", defaultValue: 5, minimum: 1, maximum: 50, restartRequired: false }),
  descriptor({ key: "currentChatSearchMaxResults", label: "Current-chat search maximum", description: "Maximum matching turns current-chat search may return.", category: "chat", type: "integer", envName: "CURRENT_CHAT_SEARCH_MAX_RESULTS", defaultValue: 10, minimum: 1, maximum: 50, restartRequired: false }),
  descriptor({ key: "currentChatSearchMaxOutputCharacters", label: "Current-chat search output", description: "Maximum characters returned by current-chat search.", category: "chat", type: "integer", envName: "CURRENT_CHAT_SEARCH_MAX_OUTPUT_CHARACTERS", defaultValue: 16_000, minimum: 1_000, maximum: 100_000, restartRequired: false }),
  descriptor({ key: "chatHistorySearchMaxResults", label: "Chat-history search results", description: "Maximum conversations returned by chat-history search.", category: "chat", type: "integer", envName: "CHAT_HISTORY_SEARCH_MAX_RESULTS", defaultValue: 50, minimum: 1, maximum: 250, restartRequired: false }),
  descriptor({ key: "chatMemoryContextMaxCharacters", label: "Recalled chat context", description: "Maximum conversation characters supplied to the chat-recall model.", category: "chat", type: "integer", envName: "CHAT_MEMORY_CONTEXT_MAX_CHARACTERS", defaultValue: 120_000, minimum: 8_000, maximum: 300_000, restartRequired: false }),
  descriptor({ key: "chatMemoryRecallMaxPromptCharacters", label: "Chat-recall prompt", description: "Maximum characters allowed in a chat-recall question.", category: "chat", type: "integer", envName: "CHAT_MEMORY_RECALL_MAX_PROMPT_CHARACTERS", defaultValue: 2_000, minimum: 100, maximum: 20_000, restartRequired: false }),
  descriptor({ key: "chatMemoryRecallMaxOutputTokens", label: "Chat-recall output tokens", description: "Maximum output tokens for private chat recall.", category: "chat", type: "integer", envName: "CHAT_MEMORY_RECALL_MAX_OUTPUT_TOKENS", defaultValue: 2_000, minimum: 128, maximum: 8_000, restartRequired: false }),
  descriptor({ key: "chatMemoryRecallTimeoutMs", label: "Chat-recall timeout", description: "Maximum time for private chat recall.", category: "chat", type: "integer", envName: "CHAT_MEMORY_RECALL_TIMEOUT_MS", defaultValue: 45_000, minimum: 1_000, maximum: 120_000, restartRequired: false }),
  descriptor({ key: "chatSummaryMaxOutputTokens", label: "Chat-summary output tokens", description: "Maximum output tokens for durable conversation summaries.", category: "chat", type: "integer", envName: "CHAT_SUMMARY_MAX_OUTPUT_TOKENS", defaultValue: 512, minimum: 64, maximum: 4_000, restartRequired: false }),
  descriptor({ key: "chatSummaryTimeoutMs", label: "Chat-summary timeout", description: "Maximum time for durable conversation summaries.", category: "chat", type: "integer", envName: "CHAT_SUMMARY_TIMEOUT_MS", defaultValue: 15_000, minimum: 1_000, maximum: 120_000, restartRequired: false }),
  descriptor({ key: "chatSummaryMaxAttempts", label: "Chat-summary attempts", description: "Maximum retry attempts for a durable conversation summary task.", category: "chat", type: "integer", envName: "CHAT_SUMMARY_MAX_ATTEMPTS", defaultValue: 3, minimum: 1, maximum: 5, restartRequired: false }),
  descriptor({ key: "chatTitleMaxOutputTokens", label: "Chat-title output tokens", description: "Maximum output tokens for automatic chat titles.", category: "chat", type: "integer", envName: "CHAT_TITLE_MAX_OUTPUT_TOKENS", defaultValue: 24, minimum: 8, maximum: 128, restartRequired: false }),
  descriptor({ key: "chatTitleTimeoutMs", label: "Chat-title timeout", description: "Maximum time for automatic chat titles.", category: "chat", type: "integer", envName: "CHAT_TITLE_TIMEOUT_MS", defaultValue: 15_000, minimum: 1_000, maximum: 60_000, restartRequired: false }),
  descriptor({ key: "reasoningSummaryMaxOutputTokens", label: "Reasoning-summary tokens", description: "Maximum output tokens for compact reasoning activity labels.", category: "chat", type: "integer", envName: "REASONING_SUMMARY_MAX_OUTPUT_TOKENS", defaultValue: 32, minimum: 8, maximum: 256, restartRequired: false }),
  descriptor({ key: "reasoningSummaryTimeoutMs", label: "Reasoning-summary timeout", description: "Maximum time for compact reasoning activity labels.", category: "chat", type: "integer", envName: "REASONING_SUMMARY_TIMEOUT_MS", defaultValue: 15_000, minimum: 1_000, maximum: 60_000, restartRequired: false }),
  descriptor({ key: "todoPlannerMaxPromptCharacters", label: "Todo-planner prompt", description: "Maximum characters taken from each input section sent to the todo planner.", category: "chat", type: "integer", envName: "TODO_PLANNER_MAX_PROMPT_CHARACTERS", defaultValue: 20_000, minimum: 1_000, maximum: 100_000, restartRequired: false }),
  descriptor({ key: "todoPlannerMaxOutputTokens", label: "Todo-planner output tokens", description: "Maximum output tokens for automatic task planning.", category: "chat", type: "integer", envName: "TODO_PLANNER_MAX_OUTPUT_TOKENS", defaultValue: 500, minimum: 64, maximum: 2_000, restartRequired: false }),
  descriptor({ key: "todoPlannerTimeoutMs", label: "Todo-planner timeout", description: "Maximum time for automatic task planning.", category: "chat", type: "integer", envName: "TODO_PLANNER_TIMEOUT_MS", defaultValue: 20_000, minimum: 1_000, maximum: 120_000, restartRequired: false }),
  descriptor({ key: "todoPlannerMaxAttempts", label: "Todo-planner attempts", description: "Maximum attempts for automatic task planning.", category: "chat", type: "integer", envName: "TODO_PLANNER_MAX_ATTEMPTS", defaultValue: 2, minimum: 1, maximum: 4, restartRequired: false }),
  descriptor({ key: "documentInlineMaxTokens", label: "Inline document tokens", description: "Maximum estimated tokens for inlining a PDF or DOCX into chat context.", category: "documents", type: "integer", envName: "DOCUMENT_INLINE_MAX_TOKENS", defaultValue: 32_000, minimum: 1_000, maximum: 100_000, restartRequired: false }),
  descriptor({ key: "documentInlineMaxPages", label: "Inline document pages", description: "Maximum pages for inlining a PDF or DOCX into chat context.", category: "documents", type: "integer", envName: "DOCUMENT_INLINE_MAX_PAGES", defaultValue: 40, minimum: 1, maximum: 200, restartRequired: false }),
  descriptor({ key: "pdfSearchMaxResults", label: "PDF search results", description: "Maximum matching pages returned by document search.", category: "documents", type: "integer", envName: "PDF_SEARCH_MAX_RESULTS", defaultValue: 10, minimum: 1, maximum: 100, restartRequired: false }),
  descriptor({ key: "pdfReadMaxPages", label: "PDF pages per read", description: "Maximum page range returned by one document-page read.", category: "documents", type: "integer", envName: "PDF_READ_MAX_PAGES", defaultValue: 20, minimum: 1, maximum: 100, restartRequired: false }),
  descriptor({ key: "imageAnalysisMaxResponseCharacters", label: "Image-analysis output", description: "Maximum characters returned for one image analysis or visual follow-up.", category: "documents", type: "integer", envName: "IMAGE_ANALYSIS_MAX_RESPONSE_CHARACTERS", defaultValue: 8_000, minimum: 500, maximum: 32_000, restartRequired: false }),
  descriptor({ key: "imageFollowupMaxQuestionCharacters", label: "Image follow-up question", description: "Maximum characters in a focused image or PDF-page visual question.", category: "documents", type: "integer", envName: "IMAGE_FOLLOWUP_MAX_QUESTION_CHARACTERS", defaultValue: 1_000, minimum: 100, maximum: 10_000, restartRequired: false }),
  descriptor({ key: "documentImageAnalysisMaxStoredCharacters", label: "Stored document-image analysis", description: "Maximum characters retained for each embedded document-image analysis.", category: "documents", type: "integer", envName: "DOCUMENT_IMAGE_ANALYSIS_MAX_STORED_CHARACTERS", defaultValue: 2_000, minimum: 500, maximum: 16_000, restartRequired: false }),
  descriptor({ key: "workspaceSearchDefaultResults", label: "Workspace search results", description: "Default matching files or lines returned by workspace search.", category: "agent", type: "integer", envName: "WORKSPACE_SEARCH_DEFAULT_RESULTS", defaultValue: 50, minimum: 1, maximum: 100, restartRequired: false }),
  descriptor({ key: "workspaceSearchMaxResults", label: "Workspace search maximum", description: "Maximum matching files or lines returned by workspace search.", category: "agent", type: "integer", envName: "WORKSPACE_SEARCH_MAX_RESULTS", defaultValue: 100, minimum: 1, maximum: 100, restartRequired: false }),
  descriptor({ key: "workspaceMaxReadOutputCharacters", label: "Workspace read output", description: "Maximum characters returned when the assistant reads a workspace file.", category: "agent", type: "integer", envName: "WORKSPACE_MAX_READ_OUTPUT_CHARACTERS", defaultValue: 256 * 1024, minimum: 8_000, maximum: 1_048_576, restartRequired: false }),
  descriptor({ key: "workspaceMaxSearchFileBytes", label: "Workspace search file size", description: "Maximum file size searched for text matches.", category: "agent", type: "integer", envName: "WORKSPACE_MAX_SEARCH_FILE_BYTES", defaultValue: 512 * 1024, minimum: 8_000, maximum: 4 * 1024 * 1024, restartRequired: false }),
  descriptor({ key: "workspaceMaxCommandOutputCharacters", label: "Workspace command output", description: "Maximum stdout or stderr characters returned from a workspace command.", category: "agent", type: "integer", envName: "WORKSPACE_MAX_COMMAND_OUTPUT_CHARACTERS", defaultValue: 64 * 1024, minimum: 8_000, maximum: 1_048_576, restartRequired: false }),
  descriptor({ key: "connectorSearchMaxResults", label: "Connector tools returned", description: "Maximum connector tools returned by connector-tool search.", category: "agent", type: "integer", envName: "CONNECTOR_SEARCH_MAX_RESULTS", defaultValue: 12, minimum: 1, maximum: 100, restartRequired: false }),
  descriptor({ key: "subagentMaxTaskCharacters", label: "Subagent task size", description: "Maximum task characters accepted by delegation.", category: "agent", type: "integer", envName: "SUBAGENT_MAX_TASK_CHARACTERS", defaultValue: 12_000, minimum: 1_000, maximum: 50_000, restartRequired: false }),
  descriptor({ key: "subagentMaxContextCharacters", label: "Subagent context size", description: "Maximum context characters supplied to a delegated task.", category: "agent", type: "integer", envName: "SUBAGENT_MAX_CONTEXT_CHARACTERS", defaultValue: 16_000, minimum: 1_000, maximum: 100_000, restartRequired: false }),
  descriptor({ key: "subagentMaxOutputCharacters", label: "Subagent output", description: "Maximum output characters returned from a delegated task.", category: "agent", type: "integer", envName: "SUBAGENT_MAX_OUTPUT_CHARACTERS", defaultValue: 40_000, minimum: 1_000, maximum: 250_000, restartRequired: false }),
  descriptor({ key: "subagentMaxSources", label: "Subagent sources", description: "Maximum sources retained from a delegated task.", category: "agent", type: "integer", envName: "SUBAGENT_MAX_SOURCES", defaultValue: 40, minimum: 1, maximum: 200, restartRequired: false }),
  descriptor({ key: "subagentMaxArtifacts", label: "Subagent artifacts", description: "Maximum artifacts retained from a delegated task.", category: "agent", type: "integer", envName: "SUBAGENT_MAX_ARTIFACTS", defaultValue: 20, minimum: 1, maximum: 100, restartRequired: false }),
  descriptor({ key: "searxngUrl", label: "SearXNG URL", description: "Internal or external SearXNG base URL.", category: "search", type: "url", envName: "SEARXNG_URL", defaultValue: "http://searxng:8080", restartRequired: false }),
  descriptor({ key: "searxngFormats", label: "SearXNG formats", description: "Formats enabled on the SearXNG endpoint.", category: "search", type: "list", defaultValue: ["html", "json"], restartRequired: true }),
  descriptor({ key: "searxngLimiter", label: "SearXNG limiter", description: "Enable SearXNG request limiting.", category: "search", type: "boolean", defaultValue: false, restartRequired: true }),
  descriptor({ key: "searxngPublicInstance", label: "SearXNG public instance", description: "Allow SearXNG to behave as a public instance.", category: "search", type: "boolean", defaultValue: false, restartRequired: true }),
  descriptor({ key: "minifluxUrl", label: "Miniflux URL", description: "RSS/news provider base URL.", category: "providers", type: "url", envName: "MINIFLUX_URL", defaultValue: "http://miniflux:8080", restartRequired: false }),
  descriptor({ key: "firecrawlUrl", label: "Firecrawl URL", description: "Page extraction provider base URL.", category: "providers", type: "url", envName: "FIRECRAWL_URL", defaultValue: "http://firecrawl:3002", restartRequired: false }),
  descriptor({ key: "opendataloaderHybridUrl", label: "OpenDataLoader URL", description: "Private PDF hybrid extraction service URL.", category: "providers", type: "url", envName: "OPENDATALOADER_HYBRID_URL", defaultValue: "http://opendataloader-hybrid:5002", restartRequired: false }),
  descriptor({ key: "pythonWorkerUrl", label: "Python worker URL", description: "Private local Python execution service URL.", category: "providers", type: "url", envName: "PYTHON_WORKER_URL", defaultValue: "http://python-worker:5003", restartRequired: true }),
  descriptor({ key: "pipedreamConnectBaseUrl", label: "Managed connector URL", description: "Base URL for the managed connector provider.", category: "providers", type: "url", envName: "PIPEDREAM_CONNECT_BASE_URL", defaultValue: "https://api.pipedream.com/v1/connect", restartRequired: false }),
  descriptor({ key: "deploymentLocation", label: "Deployment location", description: "Optional coarse location the assistant may report; never a user location.", category: "providers", type: "text", envName: "DEPLOYMENT_LOCATION", defaultValue: "", maximum: 300, restartRequired: false }),
  descriptor({ key: "searchProviderCacheTtlMs", label: "Search cache TTL", description: "Successful provider-result cache lifetime in milliseconds.", category: "search", type: "integer", envName: "SEARCH_PROVIDER_CACHE_TTL_MS", defaultValue: 15_000, minimum: 0, maximum: 300_000, restartRequired: false }),
  descriptor({ key: "searchProviderFailureThreshold", label: "Search failure threshold", description: "Consecutive provider failures before its circuit opens.", category: "search", type: "integer", envName: "SEARCH_PROVIDER_FAILURE_THRESHOLD", defaultValue: 3, minimum: 1, maximum: 10, restartRequired: false }),
  descriptor({ key: "searchProviderCircuitOpenMs", label: "Search circuit duration", description: "How long a failed provider circuit remains open in milliseconds.", category: "search", type: "integer", envName: "SEARCH_PROVIDER_CIRCUIT_OPEN_MS", defaultValue: 30_000, minimum: 1_000, maximum: 300_000, restartRequired: false }),
  descriptor({ key: "firecrawlMaxConcurrentPages", label: "Firecrawl page concurrency", description: "Maximum concurrent browser pages in the local service.", category: "providers", type: "integer", envName: "FIRECRAWL_MAX_CONCURRENT_PAGES", defaultValue: 1, minimum: 1, maximum: 4, restartRequired: true }),
  descriptor({ key: "firecrawlMaxConcurrentJobs", label: "Firecrawl job concurrency", description: "Maximum concurrent Firecrawl jobs.", category: "providers", type: "integer", envName: "FIRECRAWL_MAX_CONCURRENT_JOBS", defaultValue: 1, minimum: 1, maximum: 4, restartRequired: true }),
  descriptor({ key: "firecrawlBrowserPoolSize", label: "Firecrawl browser pool", description: "Browser pool size for the local page extractor.", category: "providers", type: "integer", envName: "FIRECRAWL_BROWSER_POOL_SIZE", defaultValue: 1, minimum: 1, maximum: 4, restartRequired: true }),
  descriptor({ key: "deepResearchMaxSearches", label: "Research search limit", description: "Maximum initial research searches.", category: "research", type: "integer", envName: "DEEP_RESEARCH_MAX_SEARCHES", defaultValue: 6, minimum: 1, maximum: 7, restartRequired: false }),
  descriptor({ key: "deepResearchMaxFetchedPages", label: "Research page limit", description: "Maximum pages fetched for one deep-research run.", category: "research", type: "integer", envName: "DEEP_RESEARCH_MAX_FETCHED_PAGES", defaultValue: 10, minimum: 1, maximum: 20, restartRequired: false }),
  descriptor({ key: "deepResearchMaxFollowUpSearches", label: "Research follow-up limit", description: "Maximum follow-up searches for unresolved claims.", category: "research", type: "integer", envName: "DEEP_RESEARCH_MAX_FOLLOW_UP_SEARCHES", defaultValue: 2, minimum: 0, maximum: 2, restartRequired: false }),
  descriptor({ key: "deepResearchMaxEvidenceTokens", label: "Research evidence tokens", description: "Maximum evidence tokens supplied to research synthesis.", category: "research", type: "integer", envName: "DEEP_RESEARCH_MAX_EVIDENCE_TOKENS", defaultValue: 12_000, minimum: 1_000, maximum: 24_000, restartRequired: false }),
  descriptor({ key: "deepResearchMaxModelCalls", label: "Research model-call limit", description: "Maximum model calls in one deep-research run.", category: "research", type: "integer", envName: "DEEP_RESEARCH_MAX_MODEL_CALLS", defaultValue: 4, minimum: 1, maximum: 4, restartRequired: false }),
  descriptor({ key: "deepResearchMaxEstimatedCostUsd", label: "Research cost limit", description: "Maximum estimated model cost per deep-research run in USD.", category: "research", type: "number", envName: "DEEP_RESEARCH_MAX_ESTIMATED_COST_USD", defaultValue: 0.1, minimum: 0, maximum: 10, restartRequired: false }),
  descriptor({ key: "deepResearchMaxPagesPerDomain", label: "Research pages per domain", description: "Maximum pages selected from one domain per run.", category: "research", type: "integer", envName: "DEEP_RESEARCH_MAX_PAGES_PER_DOMAIN", defaultValue: 2, minimum: 1, maximum: 3, restartRequired: false }),
  descriptor({ key: "deepResearchQueryPlannerMaxOutputTokens", label: "Research query-planner tokens", description: "Maximum output tokens for research query decomposition.", category: "research", type: "integer", envName: "DEEP_RESEARCH_QUERY_PLANNER_MAX_OUTPUT_TOKENS", defaultValue: 900, minimum: 128, maximum: 4_000, restartRequired: false }),
  descriptor({ key: "deepResearchQueryPlannerTimeoutMs", label: "Research query-planner timeout", description: "Maximum time for research query decomposition.", category: "research", type: "integer", envName: "DEEP_RESEARCH_QUERY_PLANNER_TIMEOUT_MS", defaultValue: 20_000, minimum: 1_000, maximum: 120_000, restartRequired: false }),
  descriptor({ key: "deepResearchClaimMaxOutputTokens", label: "Research claim-model tokens", description: "Maximum output tokens for claim extraction and verification.", category: "research", type: "integer", envName: "DEEP_RESEARCH_CLAIM_MAX_OUTPUT_TOKENS", defaultValue: 2_500, minimum: 256, maximum: 8_000, restartRequired: false }),
  descriptor({ key: "deepResearchClaimTimeoutMs", label: "Research claim-model timeout", description: "Maximum time for claim extraction and verification.", category: "research", type: "integer", envName: "DEEP_RESEARCH_CLAIM_TIMEOUT_MS", defaultValue: 25_000, minimum: 1_000, maximum: 120_000, restartRequired: false }),
  descriptor({ key: "deepResearchSynthesisMaxOutputTokens", label: "Research synthesis tokens", description: "Maximum output tokens for the final research report.", category: "research", type: "integer", envName: "DEEP_RESEARCH_SYNTHESIS_MAX_OUTPUT_TOKENS", defaultValue: 5_000, minimum: 500, maximum: 20_000, restartRequired: false }),
  descriptor({ key: "deepResearchSynthesisTimeoutMs", label: "Research synthesis timeout", description: "Maximum time for the final research report.", category: "research", type: "integer", envName: "DEEP_RESEARCH_SYNTHESIS_TIMEOUT_MS", defaultValue: 120_000, minimum: 5_000, maximum: 300_000, restartRequired: false }),
  descriptor({ key: "deepResearchMaxEvidenceCharacters", label: "Research evidence characters", description: "Maximum evidence characters supplied to final research synthesis.", category: "research", type: "integer", envName: "DEEP_RESEARCH_MAX_EVIDENCE_CHARACTERS", defaultValue: 50_000, minimum: 5_000, maximum: 250_000, restartRequired: false }),
  descriptor({ key: "deepResearchMaxSourcesPerFinding", label: "Research sources per finding", description: "Maximum sources from each finding included in synthesis evidence.", category: "research", type: "integer", envName: "DEEP_RESEARCH_MAX_SOURCES_PER_FINDING", defaultValue: 8, minimum: 1, maximum: 50, restartRequired: false }),
  descriptor({ key: "deepResearchMaxClaims", label: "Research claims", description: "Maximum normalized claims retained in one research result.", category: "research", type: "integer", envName: "DEEP_RESEARCH_MAX_CLAIMS", defaultValue: 50, minimum: 1, maximum: 200, restartRequired: false }),
  descriptor({ key: "deepResearchMaxSubagentConcurrency", label: "Research subagent concurrency", description: "Maximum approved research topics processed concurrently.", category: "research", type: "integer", envName: "DEEP_RESEARCH_MAX_SUBAGENT_CONCURRENCY", defaultValue: 3, minimum: 1, maximum: 8, restartRequired: false }),
  descriptor({ key: "deepResearchFindInPageMaxResults", label: "Research page matches", description: "Maximum matching excerpts returned by find-in-page.", category: "research", type: "integer", envName: "DEEP_RESEARCH_FIND_IN_PAGE_MAX_RESULTS", defaultValue: 20, minimum: 1, maximum: 100, restartRequired: false }),
  descriptor({ key: "deepResearchMaxPageLinks", label: "Research page links", description: "Maximum links returned from one fetched research page.", category: "research", type: "integer", envName: "DEEP_RESEARCH_MAX_PAGE_LINKS", defaultValue: 200, minimum: 1, maximum: 1_000, restartRequired: false }),
  descriptor({ key: "deepResearchPageOutputCharacters", label: "Research page output", description: "Maximum page characters returned by deep-research page tools.", category: "research", type: "integer", envName: "DEEP_RESEARCH_PAGE_OUTPUT_CHARACTERS", defaultValue: 24_000, minimum: 1_000, maximum: 80_000, restartRequired: false }),
  descriptor({ key: "chatDurableSummariesEnabled", label: "Durable chat summaries", description: "Persist bounded summaries for older conversation context.", category: "memory", type: "boolean", envName: "CHAT_DURABLE_SUMMARIES_ENABLED", defaultValue: false, restartRequired: false }),
  descriptor({ key: "userMemoryDreamingEnabled", label: "Memory dreaming", description: "Allow background memory consolidation after completed chats.", category: "memory", type: "boolean", envName: "USER_MEMORY_DREAMING_ENABLED", defaultValue: true, restartRequired: false }),
  descriptor({ key: "pdfOcrConcurrency", label: "PDF OCR concurrency", description: "Maximum concurrent local OCR pages.", category: "documents", type: "integer", envName: "PDF_OCR_CONCURRENCY", defaultValue: 2, minimum: 1, maximum: 32, restartRequired: false }),
  descriptor({ key: "pdfImageAnalysisConcurrency", label: "PDF image-analysis concurrency", description: "Maximum concurrent provider-backed PDF image analyses.", category: "documents", type: "integer", envName: "PDF_IMAGE_ANALYSIS_CONCURRENCY", defaultValue: 2, minimum: 1, maximum: 16, restartRequired: false }),
  descriptor({ key: "workerPollIntervalMs", label: "Worker poll interval", description: "Background queue poll interval in milliseconds.", category: "worker", type: "integer", envName: "WORKER_POLL_INTERVAL_MS", defaultValue: 1_000, minimum: 250, maximum: 10_000, restartRequired: true }),
  descriptor({ key: "workerHeartbeatIntervalMs", label: "Worker heartbeat interval", description: "Background-worker heartbeat write interval in milliseconds.", category: "worker", type: "integer", envName: "WORKER_HEARTBEAT_INTERVAL_MS", defaultValue: 5_000, minimum: 1_000, maximum: 60_000, restartRequired: true }),
  descriptor({ key: "workerHeartbeatMaxAgeMs", label: "Worker heartbeat max age", description: "Maximum heartbeat age accepted by the worker health check.", category: "worker", type: "integer", envName: "WORKER_HEARTBEAT_MAX_AGE_MS", defaultValue: 30_000, minimum: 5_000, maximum: 300_000, restartRequired: true }),
  descriptor({ key: "storageMaintenanceIntervalMs", label: "Maintenance interval", description: "Interval between background storage-maintenance sweeps in milliseconds.", category: "worker", type: "integer", envName: "STORAGE_MAINTENANCE_INTERVAL_MS", defaultValue: 60_000, minimum: 10_000, maximum: 3_600_000, restartRequired: true }),
  descriptor({ key: "automationSchedulerIntervalMs", label: "Automation scheduler interval", description: "Recurring-automation scheduler interval in milliseconds.", category: "worker", type: "integer", envName: "AUTOMATION_SCHEDULER_INTERVAL_MS", defaultValue: 30_000, minimum: 5_000, maximum: 3_600_000, restartRequired: true }),
  descriptor({ key: "automationSchedulerBatch", label: "Automation scheduler batch", description: "Maximum automations claimed per scheduler tick.", category: "worker", type: "integer", envName: "AUTOMATION_SCHEDULER_BATCH", defaultValue: 1, minimum: 1, maximum: 4, restartRequired: true }),
  descriptor({ key: "memorySchedulerIntervalMs", label: "Memory scheduler interval", description: "Memory recovery and consolidation scheduler interval in milliseconds.", category: "worker", type: "integer", envName: "MEMORY_SCHEDULER_INTERVAL_MS", defaultValue: 60_000, minimum: 10_000, maximum: 3_600_000, restartRequired: true }),
  descriptor({ key: "workerMaintenanceLimit", label: "Maintenance batch limit", description: "Maximum records handled by each maintenance sweep.", category: "worker", type: "integer", envName: "WORKER_MAINTENANCE_LIMIT", defaultValue: 50, minimum: 1, maximum: 50, restartRequired: true }),
  descriptor({ key: "workerChatConcurrency", label: "Chat worker concurrency", description: "Maximum concurrent chat jobs.", category: "worker", type: "integer", envName: "WORKER_CHAT_CONCURRENCY", defaultValue: 1, minimum: 1, maximum: 4, restartRequired: true }),
  descriptor({ key: "workerDocumentConcurrency", label: "Document worker concurrency", description: "Maximum concurrent document jobs.", category: "worker", type: "integer", envName: "WORKER_DOCUMENT_CONCURRENCY", defaultValue: 1, minimum: 1, maximum: 4, restartRequired: true }),
  descriptor({ key: "workerImageConcurrency", label: "Image worker concurrency", description: "Maximum concurrent image jobs.", category: "worker", type: "integer", envName: "WORKER_IMAGE_CONCURRENCY", defaultValue: 1, minimum: 1, maximum: 4, restartRequired: true }),
  descriptor({ key: "workerOcrConcurrency", label: "Worker OCR concurrency", description: "Maximum concurrent OCR work in the background worker.", category: "worker", type: "integer", envName: "WORKER_OCR_CONCURRENCY", defaultValue: 2, minimum: 1, maximum: 2, restartRequired: true }),
  descriptor({ key: "discordProcessingIntervalMs", label: "Discord processing interval", description: "Optional Discord DM processing interval in milliseconds.", category: "worker", type: "integer", envName: "DISCORD_PROCESSING_INTERVAL_MS", defaultValue: 1_000, minimum: 1_000, maximum: 60_000, restartRequired: true }),
];

export const RUNTIME_CONFIG_KEYS = RUNTIME_CONFIG_DESCRIPTORS.map(({ key }) => key) as RuntimeConfigKey[];

export function runtimeConfigDescriptor(key: RuntimeConfigKey): RuntimeConfigDescriptor {
  const value = RUNTIME_CONFIG_DESCRIPTORS.find((item) => item.key === key);
  if (!value) throw new Error(`Unknown runtime configuration key: ${key}`);
  return value;
}

export function isRuntimeConfigKey(value: unknown): value is RuntimeConfigKey {
  return typeof value === "string" && RUNTIME_CONFIG_KEYS.includes(value as RuntimeConfigKey);
}
