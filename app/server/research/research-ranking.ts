import { canonicalSourceUrl } from "../../../lib/chat-citations";
import type { SearchCandidate } from "./research-types";

const LOW_QUALITY = /(?:pinterest\.|quora\.|answers\.com$|content-farm|clickhole)/i;
const COMMUNITY = /(?:reddit\.com|news\.ycombinator\.com|stackoverflow\.com|stackexchange\.com)/i;
const PRIMARY = /(?:\.gov$|\.edu$|github\.com$|wikipedia\.org$)/i;

function host(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; }
}

function freshness(publishedAt?: string): number {
  if (!publishedAt) return 0;
  const age = Date.now() - Date.parse(publishedAt);
  if (!Number.isFinite(age) || age < 0) return 0;
  return Math.max(0, 1 - age / (730 * 86_400_000));
}

function isPrimary(candidate: SearchCandidate): boolean {
  const domain = host(candidate.url);
  if (PRIMARY.test(domain)) return true;
  if (candidate.intent === "official") {
    const terms = candidate.title.toLowerCase().split(/\W+/).filter((term) => term.length > 3);
    return terms.some((term) => domain.includes(term));
  }
  return false;
}

export function rankResearchCandidates(input: readonly SearchCandidate[]): SearchCandidate[] {
  const unique = new Map<string, SearchCandidate>();
  for (const candidate of input) {
    const key = canonicalSourceUrl(candidate.url);
    const previous = unique.get(key);
    if (!previous || candidate.rank < previous.rank) unique.set(key, candidate);
  }
  const candidates = [...unique.values()];
  const coverage = new Map<string, Set<number>>();
  const rrf = new Map<string, number>();
  for (const candidate of input) {
    const key = canonicalSourceUrl(candidate.url);
    const queries = coverage.get(key) ?? new Set<number>();
    queries.add(candidate.queryIndex);
    coverage.set(key, queries);
    rrf.set(key, (rrf.get(key) ?? 0) + 1 / (60 + candidate.rank));
  }
  const maxRrf = Math.max(...rrf.values(), 1 / 61);
  const queryCount = Math.max(1, new Set(input.map((item) => item.queryIndex)).size);
  const scored = candidates.map((candidate) => {
    const key = canonicalSourceUrl(candidate.url);
    const domain = host(candidate.url);
    const score =
      0.45 * ((rrf.get(key) ?? 0) / maxRrf) +
      0.15 * Number(isPrimary(candidate)) +
      0.10 * freshness(candidate.publishedAt) +
      0.15 * ((coverage.get(key)?.size ?? 1) / queryCount) +
      0.10 * Number(!COMMUNITY.test(domain) || candidate.intent === "community") +
      0.05 * (candidate.score ?? 0) -
      (LOW_QUALITY.test(domain) ? 0.25 : 0);
    return { ...candidate, score };
  }).sort((left, right) => (right.score ?? 0) - (left.score ?? 0));

  const selected: SearchCandidate[] = [];
  const domains = new Map<string, number>();
  for (const candidate of scored) {
    const domain = host(candidate.url);
    const repeats = domains.get(domain) ?? 0;
    selected.push({ ...candidate, score: (candidate.score ?? 0) - repeats * 0.10 });
    domains.set(domain, repeats + 1);
  }
  return selected.sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
}
