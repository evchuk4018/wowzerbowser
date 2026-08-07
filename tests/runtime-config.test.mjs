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
