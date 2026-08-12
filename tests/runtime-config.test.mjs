import assert from "node:assert/strict";
import test from "node:test";
import { RUNTIME_CONFIG_DESCRIPTORS } from "../lib/runtime-config-protocol.ts";
import { resolveRuntimeConfig } from "../app/server/config/runtime-config-service.ts";
import { searxngSettingsYaml } from "../app/server/config/searxng-config.ts";

test("runtime configuration resolves environment defaults and bounded persisted overrides", () => {
  const env = {
    SEARCH_STACK_ENABLED: "false",
    CHAT_RESPONSE_TIMEOUT_MS: "700000",
    SEARCH_PROVIDER_CACHE_TTL_MS: "60000",
    DEEP_RESEARCH_MAX_SEARCHES: "7",
    DEPLOYMENT_LOCATION: " homelab ",
  };
  const values = resolveRuntimeConfig({
    searchStackEnabled: true,
    searchProviderCacheTtlMs: 300_000,
    deepResearchMaxSearches: 999,
    unknown: "ignored",
  }, env);
  assert.equal(values.searchStackEnabled, true);
  assert.equal(values.chatResponseTimeoutMs, 700_000);
  assert.equal(values.searchProviderCacheTtlMs, 300_000);
  assert.equal(values.deepResearchMaxSearches, 7);
  assert.equal(values.deploymentLocation, "homelab");
  assert.ok(RUNTIME_CONFIG_DESCRIPTORS.some(({ key }) => key === "searxngFormats"));
  assert.ok(!RUNTIME_CONFIG_DESCRIPTORS.some(({ key }) => key === "mediawikiApiUrl"));
});

test("assistant output limits are first-class runtime configurables", () => {
  const expectedKeys = [
    "chatResponseTimeoutMs",
    "webSearchMaxResultsGeneral", "webSearchMaxResultsNews", "webSearchMaxResultsCommunity", "webSearchMaxResultsReference",
    "webFetchMaxMarkdownCharacters", "searchProviderRequestTimeoutMs", "searchProviderMaxAttempts", "searchProviderRetryDelayMs", "searchProviderMinIntervalMs",
    "focusedContextRecentTurns", "focusedContextMaxOlderTurns", "focusedContextMaxHistoryCharacters", "focusedContextRouterTimeoutMs", "focusedContextRouterMaxTokens",
    "currentChatSearchDefaultResults", "currentChatSearchMaxResults", "currentChatSearchMaxOutputCharacters", "chatHistorySearchMaxResults",
    "chatMemoryContextMaxCharacters", "chatMemoryRecallMaxPromptCharacters", "chatMemoryRecallMaxOutputTokens", "chatMemoryRecallTimeoutMs",
    "chatSummaryMaxOutputTokens", "chatSummaryTimeoutMs", "chatSummaryMaxAttempts", "chatTitleMaxOutputTokens", "chatTitleTimeoutMs", "reasoningSummaryMaxOutputTokens", "reasoningSummaryTimeoutMs",
    "todoPlannerMaxPromptCharacters", "todoPlannerMaxOutputTokens", "todoPlannerTimeoutMs", "todoPlannerMaxAttempts",
    "documentInlineMaxTokens", "documentInlineMaxPages", "pdfSearchMaxResults", "pdfReadMaxPages", "imageAnalysisMaxResponseCharacters", "imageFollowupMaxQuestionCharacters", "documentImageAnalysisMaxStoredCharacters",
    "workspaceSearchDefaultResults", "workspaceSearchMaxResults", "workspaceMaxReadOutputCharacters", "workspaceMaxSearchFileBytes", "workspaceMaxCommandOutputCharacters",
    "connectorSearchMaxResults", "subagentMaxTaskCharacters", "subagentMaxContextCharacters", "subagentMaxOutputCharacters", "subagentMaxSources", "subagentMaxArtifacts",
    "deepResearchQueryPlannerMaxOutputTokens", "deepResearchQueryPlannerTimeoutMs", "deepResearchClaimMaxOutputTokens", "deepResearchClaimTimeoutMs",
    "deepResearchSynthesisMaxOutputTokens", "deepResearchSynthesisTimeoutMs", "deepResearchMaxEvidenceCharacters", "deepResearchMaxSourcesPerFinding", "deepResearchMaxClaims", "deepResearchMaxSubagentConcurrency", "deepResearchFindInPageMaxResults", "deepResearchMaxPageLinks", "deepResearchPageOutputCharacters",
  ];
  const descriptors = new Map(RUNTIME_CONFIG_DESCRIPTORS.map((descriptor) => [descriptor.key, descriptor]));
  for (const key of expectedKeys) {
    const descriptor = descriptors.get(key);
    assert.ok(descriptor, `missing descriptor: ${key}`);
    assert.equal(descriptor.type === "integer" || descriptor.type === "number", true, `${key} must be numeric`);
    assert.equal(descriptor.restartRequired, false, `${key} should apply without a restart`);
    assert.ok(descriptor.envName, `${key} needs an environment fallback`);
  }
});

test("interactive chat timeout defaults to 500 seconds and remains safely bounded", () => {
  const descriptor = RUNTIME_CONFIG_DESCRIPTORS.find(({ key }) => key === "chatResponseTimeoutMs");
  assert.deepEqual({
    defaultValue: descriptor?.defaultValue,
    minimum: descriptor?.minimum,
    maximum: descriptor?.maximum,
    envName: descriptor?.envName,
    restartRequired: descriptor?.restartRequired,
  }, {
    defaultValue: 500_000,
    minimum: 60_000,
    maximum: 3_600_000,
    envName: "CHAT_RESPONSE_TIMEOUT_MS",
    restartRequired: false,
  });
  assert.equal(resolveRuntimeConfig({}, {}).chatResponseTimeoutMs, 500_000);
  assert.equal(resolveRuntimeConfig({}, { CHAT_RESPONSE_TIMEOUT_MS: "1" }).chatResponseTimeoutMs, 60_000);
  assert.equal(resolveRuntimeConfig({}, { CHAT_RESPONSE_TIMEOUT_MS: "9999999" }).chatResponseTimeoutMs, 3_600_000);
});

test("SearXNG settings are generated from the structured safe schema", () => {
  const yaml = searxngSettingsYaml({
    searxngFormats: ["json", "html"],
    searxngLimiter: true,
    searxngPublicInstance: false,
  });
  assert.match(yaml, /use_default_settings: true/);
  assert.match(yaml, /- "json"/);
  assert.match(yaml, /limiter: true/);
  assert.match(yaml, /public_instance: false/);
  assert.doesNotMatch(yaml, /password|api_key/i);
});
