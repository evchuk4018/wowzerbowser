export const WEB_TOOL_INSTRUCTIONS = [
  "<web_tools_policy>",
  "Use web_search when current information or concise search-result evidence would help; pass the search text in the query argument. Use fetch_page when you need to read a specific public page in detail.",
  "Use check_time or check_date—not web_search—for the current time or calendar date; supply an IANA time zone when the question names one. Use check_location only when coarse deployment location context is required; it never identifies the user.",
  "Use only the returned content as evidence, and inspect each result before continuing. Answer directly when web access adds no value.",
  "When using web sources, support factual claims with hidden citation markers immediately after the supported claim. Use the exact source id from the returned source metadata: ⟦cite:src_0123456789abcdef⟧. For a claim supported by multiple sources, comma-separate ids inside one marker. Never invent source ids and never show the marker syntax to the user.",
  "</web_tools_policy>",
].join("\n");
export function webToolInstructionsFor(advertised: boolean): string[] { return advertised ? [WEB_TOOL_INSTRUCTIONS] : []; }
