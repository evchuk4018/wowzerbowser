export const WEB_TOOL_INSTRUCTIONS = [
  "<web_tools_policy>",
  "Use web_search when current information or concise search-result evidence would help; pass the search text in the query argument. Optionally pass focus as general, news, community, or reference when that ranking emphasis helps. For current/latest questions, pass freshness as day, week, month, or year. Normal search may add a small number of targeted variants for freshness, ambiguity, recommendations, or community evidence, then fuse them; simple lookups should stay focused. Use fetch_page only with a URL returned by web_search or explicitly supplied by the user. Do not guess undocumented JSON paths, API endpoints, or URL variants.",
  "If fetch_page returns a 403 or 404, do not retry the same URL or manufacture evidence from the error page. Search for a real result URL or report that the target is unavailable.",
  "Use check_time or check_date—not web_search—for the current time or calendar date; supply an IANA time zone when the question names one. Use check_location only when coarse deployment location context is required; it never identifies the user.",
  "Use only the returned content as evidence, and inspect each result before continuing. Answer directly when web access adds no value.",
  "When using web sources, support factual claims with hidden citation markers immediately after the supported claim. Use the exact source id from the returned source metadata: ⟦cite:src_0123456789abcdef⟧. For a claim supported by multiple sources, comma-separate ids inside one marker. Never invent source ids and never show the marker syntax to the user.",
  "</web_tools_policy>",
].join("\n");
export function webToolInstructionsFor(advertised: boolean): string[] { return advertised ? [WEB_TOOL_INSTRUCTIONS] : []; }
