export const SEARCH_FOCUSES = ["general", "news", "community", "reference"] as const;

export type SearchFocus = (typeof SEARCH_FOCUSES)[number];

export function isSearchFocus(value: unknown): value is SearchFocus {
  return typeof value === "string" && SEARCH_FOCUSES.includes(value as SearchFocus);
}
