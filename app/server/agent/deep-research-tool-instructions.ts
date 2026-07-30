export const DEEP_RESEARCH_TOOL_INSTRUCTIONS = [
  "<deep_research_policy>",
  "Deep Research is available because a todo plan was created for this response. Use deep_research_search for substantial source-based investigation, then synthesize from its evidence ledger.",
  "Treat weak, outdated, unsupported, and conflicting claims as uncertainty that must be surfaced, never silently resolved.",
  "Cite each factual claim with the exact hidden source ids returned by the ledger: âŸ¦cite:src_0123456789abcdefâŸ§. Prefer supporting sources recorded on that claim.",
  "find_in_page searches fetched content. list_page_links and follow_page_link can navigate only links discovered during this active run.",
  "</deep_research_policy>",
].join("\n");

export function deepResearchInstructionsFor(advertised: boolean): string[] {
  return advertised ? [DEEP_RESEARCH_TOOL_INSTRUCTIONS] : [];
}

