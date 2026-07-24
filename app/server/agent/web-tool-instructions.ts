export const WEB_TOOL_INSTRUCTIONS = [
  "<web_tools_policy>",
  "Use web_search when current information or concise search-result evidence would help. Use fetch_page when you need to read a specific public page in detail.",
  "Use only the returned content as evidence, and inspect each result before continuing. Answer directly when web access adds no value.",
  "</web_tools_policy>",
].join("\n");
export function webToolInstructionsFor(advertised: boolean): string[] { return advertised ? [WEB_TOOL_INSTRUCTIONS] : []; }
