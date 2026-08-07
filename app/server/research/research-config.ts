import "server-only";
import type { ResearchLimits } from "./research-types";
import { runtimeConfigSnapshot } from "../config/runtime-config-service";

export function researchLimits(): ResearchLimits {
  const config = runtimeConfigSnapshot();
  return {
    maxSearches: config.deepResearchMaxSearches,
    maxFetchedPages: config.deepResearchMaxFetchedPages,
    maxFollowUpSearches: config.deepResearchMaxFollowUpSearches,
    maxEvidenceTokens: config.deepResearchMaxEvidenceTokens,
    maxModelCalls: config.deepResearchMaxModelCalls,
    maxEstimatedCostUsd: config.deepResearchMaxEstimatedCostUsd,
    maxPagesPerDomain: config.deepResearchMaxPagesPerDomain,
  };
}
