import type { ChatSource } from "../../../lib/chat-citations";
import type { SearchFocus, SearchFreshness } from "../../../lib/search-protocol";

export const SEARCH_PROVIDER_NAMES = ["searxng", "searxng-reddit", "mediawiki", "miniflux"] as const;
export type SearchProviderName = (typeof SEARCH_PROVIDER_NAMES)[number];

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
