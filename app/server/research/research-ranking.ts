import type { SearchCandidate } from "./research-types";
import { rankSearchCandidates } from "../search/search-ranking";

export function rankResearchCandidates(input: readonly SearchCandidate[]): SearchCandidate[] {
  return rankSearchCandidates(input, { mode: "research" });
}
