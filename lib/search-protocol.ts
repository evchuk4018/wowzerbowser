export const SEARCH_FOCUSES = ["general", "news", "community", "reference"] as const;
export const SEARCH_FRESHNESSES = ["day", "week", "month", "year"] as const;

export type SearchFocus = (typeof SEARCH_FOCUSES)[number];
export type SearchFreshness = (typeof SEARCH_FRESHNESSES)[number];

export function isSearchFocus(value: unknown): value is SearchFocus {
  return typeof value === "string" && SEARCH_FOCUSES.includes(value as SearchFocus);
}

export function isSearchFreshness(value: unknown): value is SearchFreshness {
  return typeof value === "string" && SEARCH_FRESHNESSES.includes(value as SearchFreshness);
}
