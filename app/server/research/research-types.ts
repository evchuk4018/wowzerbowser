import type { ResearchBudget, ResearchClaim } from "../../../lib/chat-protocol";
import type { ChatSource } from "../../../lib/chat-citations";

export type ResearchIntent = "official" | "recent" | "analysis" | "community" | "contradicting" | "academic" | "developer";

export type ResearchQuery = {
  query: string;
  intent: ResearchIntent;
  freshness?: "day" | "week" | "month" | "year";
};

export type SearchCandidate = ChatSource & {
  provider: string;
  queryIndex: number;
  rank: number;
  intent: ResearchIntent;
  extraSnippets: string[];
  score?: number;
};

export type ResearchLink = { url: string; text: string };

export type FetchedResearchPage = {
  id: string;
  source: ChatSource;
  markdown: string;
  links: Array<ResearchLink & { id: string }>;
  extractor: string;
  contentHash: string;
  contentType: string;
};

export type ResearchLimits = {
  maxSearches: number;
  maxFetchedPages: number;
  maxFollowUpSearches: number;
  maxEvidenceTokens: number;
  maxModelCalls: number;
  maxEstimatedCostUsd: number;
  maxPagesPerDomain: number;
};

export type ResearchRun = {
  id: string;
  request: string;
  allowedUrls: Set<string>;
  pages: Map<string, FetchedResearchPage>;
  claims: ResearchClaim[];
  sources: ChatSource[];
  budget: ResearchBudget;
  limits: ResearchLimits;
  warnings: string[];
};
