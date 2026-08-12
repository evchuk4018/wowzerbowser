import type { ChatSource } from "../../../lib/chat-citations";
import type { SearchFocus, SearchFreshness } from "../../../lib/search-protocol";

export const SEARCH_PROVIDER_NAMES = ["searxng", "searxng-reddit", "miniflux"] as const;
export type SearchProviderName = (typeof SEARCH_PROVIDER_NAMES)[number];

export class SearchProviderBlockedError extends Error {
  readonly reasons: string[];

  constructor(readonly provider: SearchProviderName, reasons: readonly string[]) {
    const normalized = [...new Set(reasons.map((reason) => reason.replace(/\s+/gu, " ").trim()).filter(Boolean))].slice(0, 8);
    super(`Search provider ${provider} is blocked or unavailable${normalized.length ? ` (${normalized.join(", ")})` : ""}.`);
    this.name = "SearchProviderBlockedError";
    this.reasons = normalized;
  }
}

export type SearchProviderQuery = {
  query: string;
  focus: SearchFocus;
  count: number;
  queryIndex: number;
  intent: string;
  freshness?: SearchFreshness;
  relevanceQuery?: string;
};

export type SearchCandidate = ChatSource & {
  provider: SearchProviderName;
  queryIndex: number;
  rank: number;
  intent: string;
  extraSnippets: string[];
  relevanceScore?: number;
  score?: number;
};
