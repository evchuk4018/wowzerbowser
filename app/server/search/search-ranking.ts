import { canonicalSourceUrl } from "../../../lib/chat-citations";
import type { SearchFocus } from "../../../lib/search-protocol";
import type { SearchCandidate, SearchProviderName } from "./search-types";

export type SearchRankingMode = "normal" | "research";

export type SearchRankingOptions = {
  focus?: SearchFocus;
  mode?: SearchRankingMode;
  maxResults?: number;
};

const PROVIDER_WEIGHTS: Record<SearchFocus, Record<SearchProviderName, number>> = {
  general: { searxng: 1, "searxng-reddit": 0.9, mediawiki: 0.9, miniflux: 0.9 },
  news: { searxng: 1, "searxng-reddit": 0.65, mediawiki: 0.55, miniflux: 1.55 },
  community: { searxng: 0.85, "searxng-reddit": 1.55, mediawiki: 0.6, miniflux: 0.65 },
  reference: { searxng: 0.85, "searxng-reddit": 0.55, mediawiki: 1.6, miniflux: 0.6 },
};

const LOW_QUALITY = /(?:pinterest\.|quora\.|answers\.com$|content-farm|clickhole)/i;
const COMMUNITY = /(?:reddit\.com|news\.ycombinator\.com|stackoverflow\.com|stackexchange\.com)/i;
const PRIMARY = /(?:\.gov$|\.edu$|github\.com$|wikipedia\.org$)/i;
const NEWS = /(?:reuters\.com|apnews\.com|bbc\.|nytimes\.com|theguardian\.com|npr\.org)/i;

function host(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, "").replace(/\.$/, "").toLowerCase(); } catch { return ""; }
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function freshness(publishedAt?: string): number {
  if (!publishedAt) return 0;
  const age = Date.now() - Date.parse(publishedAt);
  if (!Number.isFinite(age) || age < 0) return 0;
  return Math.max(0, 1 - age / (730 * 86_400_000));
}

function isPrimary(candidate: SearchCandidate, domain: string): boolean {
  if (PRIMARY.test(domain)) return true;
  if (candidate.intent.toLowerCase() !== "official") return false;
  const terms = candidate.title.toLowerCase().split(/\W+/u).filter((term) => term.length > 3);
  return terms.some((term) => domain.includes(term));
}

function sourceQuality(candidate: SearchCandidate, domain: string): number {
  if (LOW_QUALITY.test(domain)) return 0;
  if (isPrimary(candidate, domain)) return 1;
  if (candidate.provider === "mediawiki") return 0.85;
  if (candidate.provider === "miniflux" || NEWS.test(domain)) return 0.75;
  if (candidate.provider === "searxng-reddit" || COMMUNITY.test(domain)) return 0.6;
  return 0.5;
}

function intentFit(candidate: SearchCandidate, focus: SearchFocus): number {
  const intent = candidate.intent.toLowerCase();
  const domain = host(candidate.url);
  const community = COMMUNITY.test(domain) || candidate.provider === "searxng-reddit";
  const news = NEWS.test(domain) || candidate.provider === "miniflux";
  const reference = isPrimary(candidate, domain) || candidate.provider === "mediawiki";

  if (focus === "community") return community || intent === "community" ? 1 : 0.35;
  if (focus === "news") return news || intent === "recent" ? 1 : 0.35;
  if (focus === "reference") return reference || /official|academic|developer/.test(intent) ? 1 : 0.35;
  if (intent === "community" && !community) return 0.5;
  return 1;
}

function representativeQuality(candidate: SearchCandidate, focus: SearchFocus): number {
  const weight = PROVIDER_WEIGHTS[focus][candidate.provider];
  const relevance = candidate.relevanceScore ?? candidate.score ?? 0;
  return weight / (30 + Math.max(1, candidate.rank)) + clamp(relevance) * 0.1;
}

function relevance(candidate: SearchCandidate): number {
  return clamp(candidate.relevanceScore ?? candidate.score ?? 0);
}

export function rankSearchCandidates(
  input: readonly SearchCandidate[],
  options: SearchRankingOptions = {},
): SearchCandidate[] {
  if (!input.length) return [];

  const focus = options.focus ?? "general";
  const mode = options.mode ?? "normal";
  const unique = new Map<string, SearchCandidate>();
  const coverage = new Map<string, Set<number>>();
  const rrf = new Map<string, number>();

  for (const candidate of input) {
    const key = canonicalSourceUrl(candidate.url);
    const previous = unique.get(key);
    if (!previous || representativeQuality(candidate, focus) > representativeQuality(previous, focus)) {
      unique.set(key, candidate);
    }

    const queries = coverage.get(key) ?? new Set<number>();
    queries.add(candidate.queryIndex);
    coverage.set(key, queries);
    rrf.set(key, (rrf.get(key) ?? 0) + 1 / (60 + Math.max(1, candidate.rank)));
  }

  const maxRrf = Math.max(...rrf.values(), 1 / 61);
  const queryCount = Math.max(1, new Set(input.map((candidate) => candidate.queryIndex)).size);
  const scored = [...unique.entries()].map(([key, candidate]) => {
    const domain = host(candidate.url);
    const normalizedRrf = (rrf.get(key) ?? 0) / maxRrf;
    const queryCoverage = (coverage.get(key)?.size ?? 1) / queryCount;
    const quality = sourceQuality(candidate, domain);
    const fresh = freshness(candidate.publishedAt);
    const intent = intentFit(candidate, focus);
    const candidateRelevance = relevance(candidate);
    const providerWeight = clamp(PROVIDER_WEIGHTS[focus][candidate.provider] / 1.6);
    const score = mode === "research"
      ? 0.45 * normalizedRrf
        + 0.15 * Number(isPrimary(candidate, domain))
        + 0.10 * fresh
        + 0.15 * queryCoverage
        + 0.10 * Number(!COMMUNITY.test(domain) || candidate.intent.toLowerCase() === "community")
        + 0.05 * candidateRelevance
        - (LOW_QUALITY.test(domain) ? 0.25 : 0)
      : 0.30 * normalizedRrf
        + 0.15 * quality
        + 0.12 * fresh
        + 0.12 * queryCoverage
        + 0.13 * intent
        + 0.08 * providerWeight
        + 0.10 * candidateRelevance
        - (LOW_QUALITY.test(domain) ? 0.20 : 0);
    return { candidate, score };
  });

  const selected: SearchCandidate[] = [];
  const domainCounts = new Map<string, number>();
  const limit = options.maxResults === undefined
    ? Number.POSITIVE_INFINITY
    : Math.max(0, Math.floor(options.maxResults));
  const remaining = [...scored];

  while (remaining.length && selected.length < limit) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < remaining.length; index += 1) {
      const domain = host(remaining[index].candidate.url);
      const repeats = domainCounts.get(domain) ?? 0;
      const diversityPenalty = mode === "research" ? 0.10 : 0.08;
      const adjustedScore = remaining[index].score - repeats * diversityPenalty;
      if (adjustedScore > bestScore) {
        bestIndex = index;
        bestScore = adjustedScore;
      }
    }

    const [best] = remaining.splice(bestIndex, 1);
    const domain = host(best.candidate.url);
    domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1);
    selected.push({ ...best.candidate, score: bestScore });
  }

  return selected;
}
