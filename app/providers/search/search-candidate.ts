import { CHAT_SOURCE_SNIPPET_MAX_LENGTH, sourceForUrl } from "../../../lib/chat-citations";
import type { SearchCandidate, SearchProviderQuery } from "../../server/search/search-types";
import { array, text } from "./search-http";

export function candidate(input: {
  title: unknown;
  url: unknown;
  snippet?: unknown;
  publishedAt?: unknown;
  provider: SearchCandidate["provider"];
  query: SearchProviderQuery;
  rank: number;
  extraSnippets?: unknown;
}): SearchCandidate | null {
  const url = text(input.url, 2_000);
  if (!/^https?:\/\//i.test(url)) return null;
  return {
    ...sourceForUrl({
      title: text(input.title, 300),
      url,
      snippet: text(input.snippet, CHAT_SOURCE_SNIPPET_MAX_LENGTH),
      publishedAt: text(input.publishedAt, 100),
    }),
    provider: input.provider,
    queryIndex: input.query.queryIndex,
    rank: input.rank,
    intent: input.query.intent,
    extraSnippets: array(input.extraSnippets).map((item) => text(item, 1_000)).filter(Boolean).slice(0, 5),
  };
}
