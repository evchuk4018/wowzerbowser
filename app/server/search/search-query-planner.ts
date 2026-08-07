import type { SearchFocus, SearchFreshness } from "../../../lib/search-protocol";

export type PlannedSearchQuery = {
  query: string;
  queryIndex: number;
  intent: string;
  freshness?: SearchFreshness;
  relevanceQuery: string;
};

const CURRENT_QUERY = /\b(?:current|latest|recent|today|now|breaking|this week|this month|newest|news)\b/i;
const RECOMMENDATION_QUERY = /\b(?:best|recommend(?:ation|ations)?|review(?:s)?|top|worth|should i|alternatives?|compare|comparison|versus|\bvs\b)\b/i;
const COMMUNITY_QUERY = /\b(?:reddit|forum(?:s)?|community|discussion|experience(?:s)?|users?|owners?|feedback)\b/i;
const AMBIGUITY_QUERY = /\b(?:meaning|definition|difference between|what does .* mean|vs\.?|versus)\b/i;
const LOOKUP_QUERY = /^(?:what is|who is|where is|when was|how do i|how to|define|documentation|docs)\b/i;

function normalized(value: string): string {
  return value.toLocaleLowerCase("en-US").replace(/\s+/g, " ").trim();
}

function queryIntent(input: { query: string; focus: SearchFocus; freshness?: SearchFreshness }): string {
  if (input.focus === "community" || COMMUNITY_QUERY.test(input.query)) return "community";
  if (input.freshness || input.focus === "news" || CURRENT_QUERY.test(input.query)) return "recent";
  if (RECOMMENDATION_QUERY.test(input.query)) return "recommendation";
  if (AMBIGUITY_QUERY.test(input.query)) return "ambiguous";
  if (input.focus === "reference") return "official";
  return "lookup";
}

function shouldExpand(input: { query: string; focus: SearchFocus; freshness?: SearchFreshness }, intent: string): boolean {
  if (input.freshness || input.focus === "news" || intent === "community" || intent === "recent" || intent === "recommendation") return true;
  if (intent === "ambiguous") return true;
  const base = input.query.trim();
  const tokenCount = base.split(/\s+/u).filter(Boolean).length;
  return tokenCount <= 2 && tokenCount > 0 && !LOOKUP_QUERY.test(base) && /^[A-Z]/u.test(base);
}

function appendVariant(base: string, suffix: string, existing: Set<string>): string | null {
  const variant = `${base} ${suffix}`.replace(/\s+/g, " ").trim();
  const key = normalized(variant);
  if (!key || existing.has(key)) return null;
  existing.add(key);
  return variant;
}

export function planSearchQueries(input: {
  query: string;
  focus?: SearchFocus;
  freshness?: SearchFreshness;
  queryIndex?: number;
  intent?: string;
}): PlannedSearchQuery[] {
  const base = input.query.replace(/\s+/g, " ").trim();
  if (!base) return [];
  const focus = input.focus ?? "general";
  const inferredIntent = queryIntent({ query: base, focus, freshness: input.freshness });
  const intent = input.intent?.trim() && input.intent !== "general" ? input.intent.trim() : inferredIntent;
  const variants = [base];
  const seen = new Set([normalized(base)]);

  if (shouldExpand({ query: base, focus, freshness: input.freshness }, intent)) {
    const suffixes = intent === "recent"
      ? ["latest updates", "recent coverage"]
      : intent === "recommendation"
        ? ["reviews comparison", "alternatives pros cons"]
        : intent === "community"
          ? ["community experiences", "discussion feedback"]
          : intent === "ambiguous"
            ? ["official explanation", "overview context"]
            : ["official documentation", "explained overview"];
    for (const suffix of suffixes) {
      const variant = appendVariant(base, suffix, seen);
      if (variant) variants.push(variant);
      if (variants.length === 3) break;
    }
  }

  const baseIndex = input.queryIndex ?? 0;
  return variants.map((query, index) => ({
    query,
    queryIndex: baseIndex + index,
    intent,
    ...(input.freshness ? { freshness: input.freshness } : {}),
    relevanceQuery: base,
  }));
}
