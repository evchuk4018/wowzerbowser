export const WEB_TOOL_INSTRUCTIONS = [
  "<web_tools_policy>",
  "Use web_search when current information or concise search-result evidence would help. Use fetch_page when you need to read a specific public page in detail.",
  "Use check_time or check_date for current temporal questions; supply an IANA time zone when the question names one. Use check_location only when coarse deployment location context is required; it never identifies the user.",
  "Use only the returned content as evidence, and inspect each result before continuing. Answer directly when web access adds no value.",
  "</web_tools_policy>",
].join("\n");
export function webToolInstructionsFor(advertised: boolean): string[] { return advertised ? [WEB_TOOL_INSTRUCTIONS] : []; }
