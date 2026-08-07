import assert from "node:assert/strict";
import test from "node:test";
import { RUNTIME_CONFIG_DESCRIPTORS } from "../lib/runtime-config-protocol.ts";
import { resolveRuntimeConfig } from "../app/server/config/runtime-config-service.ts";
import { searxngSettingsYaml } from "../app/server/config/searxng-config.ts";

test("runtime configuration resolves environment defaults and bounded persisted overrides", () => {
  const env = {
    SEARCH_STACK_ENABLED: "false",
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
  assert.equal(values.searchProviderCacheTtlMs, 300_000);
  assert.equal(values.deepResearchMaxSearches, 7);
  assert.equal(values.deploymentLocation, "homelab");
  assert.ok(RUNTIME_CONFIG_DESCRIPTORS.some(({ key }) => key === "searxngFormats"));
});

test("assistant output limits are first-class runtime configurables", () => {
  const expectedKeys = [
    "webSearchMaxResultsGeneral", "webSearchMaxResultsNews", "webSearchMaxResultsCommunity", "webSearchMaxResultsReference",
    "webFetchMaxMarkdownCharacters", "searchProviderRequestTimeoutMs", "searchProviderMaxAttempts", "searchProviderRetryDelayMs",
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
