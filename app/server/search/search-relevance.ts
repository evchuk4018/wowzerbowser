import type { SearchCandidate } from "./search-types";

const STOP_WORDS = new Set([
  "a", "about", "an", "and", "are", "at", "be", "by", "for", "from", "how", "in", "is", "it", "me",
  "of", "on", "or", "please", "search", "tell", "the", "to", "what", "when", "where", "which", "who", "why",
  "with", "look", "up", "top", "best", "latest", "current", "recent", "today", "now", "news",
  "recommend", "recommendation", "recommendations", "review", "reviews", "compare", "comparison", "versus", "vs",
  "alternative", "alternatives", "pros", "cons", "community", "discussion", "experiences", "experience", "feedback",
  "official", "documentation", "docs", "explained", "overview", "context", "updates", "coverage",
]);

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("en-US");
}

export function searchLexicalTokens(value: string): string[] {
  return normalize(value)
    .split(/[^\p{L}\p{N}]+/gu)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function tokenForms(token: string): string[] {
  const forms = [token];
  if (token.length > 4 && token.endsWith("ies")) forms.push(`${token.slice(0, -3)}y`);
  if (token.length > 4 && token.endsWith("s")) forms.push(token.slice(0, -1));
  return forms;
}

function matchesTerm(term: string, values: Set<string>): boolean {
  return tokenForms(term).some((form) => values.has(form));
}

function overlap(terms: readonly string[], values: Set<string>): number {
  if (!terms.length) return 0;
  return terms.filter((term) => matchesTerm(term, values)).length / terms.length;
}

function normalizedPhrase(value: string): string {
  return normalize(value).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function scoreSearchCandidate(candidate: Pick<SearchCandidate, "title" | "snippet">, query: string): number {
  const terms = [...new Set(searchLexicalTokens(query))];
  if (!terms.length) return 0.5;

  const title = new Set(searchLexicalTokens(candidate.title));
  const snippet = new Set(searchLexicalTokens(candidate.snippet));
  const titleOverlap = overlap(terms, title);
  const snippetOverlap = overlap(terms, snippet);
  const phrase = normalizedPhrase(query);
  const titlePhrase = normalizedPhrase(candidate.title);
  const snippetPhrase = normalizedPhrase(candidate.snippet);
  const phraseBonus = phrase && (titlePhrase.includes(phrase) || snippetPhrase.includes(phrase)) ? 1 : 0;
  return Math.max(0, Math.min(1, 0.60 * titleOverlap + 0.30 * snippetOverlap + 0.10 * phraseBonus));
}

export function isSearchCandidateRelevant(candidate: Pick<SearchCandidate, "title" | "snippet">, query: string): boolean {
  const terms = [...new Set(searchLexicalTokens(query))];
  if (!terms.length) return true;

  const resultTokens = new Set([...searchLexicalTokens(candidate.title), ...searchLexicalTokens(candidate.snippet)]);
  const matched = terms.filter((term) => matchesTerm(term, resultTokens)).length;
  if (matched < Math.min(2, terms.length)) return false;
  return scoreSearchCandidate(candidate, query) >= (terms.length === 1 ? 0.12 : 0.22);
}
