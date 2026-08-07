export type RuntimeConfigValue = boolean | number | string | string[];

export type RuntimeConfigKey =
  | "searchStackEnabled"
  | "searxngUrl"
  | "searxngFormats"
  | "searxngLimiter"
  | "searxngPublicInstance"
  | "mediawikiApiUrl"
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
  | "chatDurableSummariesEnabled"
  | "userMemoryDreamingEnabled"
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
        : Key extends "deploymentLocation" | "searxngUrl" | "mediawikiApiUrl" | "minifluxUrl" | "firecrawlUrl" | "opendataloaderHybridUrl" | "pythonWorkerUrl" | "pipedreamConnectBaseUrl"
          ? string
          : number;

export type RuntimeConfigFieldType = "boolean" | "integer" | "number" | "text" | "url" | "list";

export type RuntimeConfigDescriptor = {
  key: RuntimeConfigKey;
  label: string;
  description: string;
  category: "search" | "providers" | "research" | "documents" | "worker" | "memory";
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
  descriptor({ key: "searxngUrl", label: "SearXNG URL", description: "Internal or external SearXNG base URL.", category: "search", type: "url", envName: "SEARXNG_URL", defaultValue: "http://searxng:8080", restartRequired: false }),
  descriptor({ key: "searxngFormats", label: "SearXNG formats", description: "Formats enabled on the SearXNG endpoint.", category: "search", type: "list", defaultValue: ["html", "json"], restartRequired: true }),
  descriptor({ key: "searxngLimiter", label: "SearXNG limiter", description: "Enable SearXNG request limiting.", category: "search", type: "boolean", defaultValue: false, restartRequired: true }),
  descriptor({ key: "searxngPublicInstance", label: "SearXNG public instance", description: "Allow SearXNG to behave as a public instance.", category: "search", type: "boolean", defaultValue: false, restartRequired: true }),
  descriptor({ key: "mediawikiApiUrl", label: "MediaWiki API URL", description: "Explicit MediaWiki-compatible reference-search endpoint.", category: "providers", type: "url", envName: "MEDIAWIKI_API_URL", defaultValue: "https://en.wikipedia.org/w/api.php", restartRequired: false }),
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
