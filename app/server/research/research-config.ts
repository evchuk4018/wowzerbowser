import "server-only";
import type { ResearchLimits } from "./research-types";

const integer = (name: string, fallback: number, minimum: number, maximum: number): number => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
};

const money = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

export function researchLimits(): ResearchLimits {
  return {
    maxSearches: integer("DEEP_RESEARCH_MAX_SEARCHES", 6, 1, 7),
    maxFetchedPages: integer("DEEP_RESEARCH_MAX_FETCHED_PAGES", 10, 1, 20),
    maxFollowUpSearches: integer("DEEP_RESEARCH_MAX_FOLLOW_UP_SEARCHES", 2, 0, 2),
    maxEvidenceTokens: integer("DEEP_RESEARCH_MAX_EVIDENCE_TOKENS", 12_000, 1_000, 24_000),
    maxModelCalls: integer("DEEP_RESEARCH_MAX_MODEL_CALLS", 4, 1, 4),
    maxEstimatedCostUsd: money("DEEP_RESEARCH_MAX_ESTIMATED_COST_USD", 0.10),
    maxPagesPerDomain: integer("DEEP_RESEARCH_MAX_PAGES_PER_DOMAIN", 2, 1, 3),
  };
}

