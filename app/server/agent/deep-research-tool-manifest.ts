import "server-only";
import type { DeepSeekToolDefinition } from "../../providers/deepseek/deepseek-adapter";
import { openRouterApiKey } from "../../providers/openrouter/openrouter-config";

export const DEEP_RESEARCH_SEARCH_TOOL_NAME = "deep_research_search";
export const FIND_IN_PAGE_TOOL_NAME = "find_in_page";
export const LIST_PAGE_LINKS_TOOL_NAME = "list_page_links";
export const FOLLOW_PAGE_LINK_TOOL_NAME = "follow_page_link";

export const DEEP_RESEARCH_TOOL_DEFINITIONS: DeepSeekToolDefinition[] = [
  { type: "function", function: { name: DEEP_RESEARCH_SEARCH_TOOL_NAME, description: "Run a bounded, multi-source deep-research workflow and return a verified evidence ledger.", parameters: { type: "object", additionalProperties: false, required: ["request"], properties: { request: { type: "string", minLength: 1, maxLength: 20_000 } } } } },
  { type: "function", function: { name: FIND_IN_PAGE_TOOL_NAME, description: "Find relevant excerpts inside a page fetched by the active deep-research run.", parameters: { type: "object", additionalProperties: false, required: ["pageId", "query"], properties: { pageId: { type: "string", minLength: 1, maxLength: 80 }, query: { type: "string", minLength: 1, maxLength: 400 } } } } },
  { type: "function", function: { name: LIST_PAGE_LINKS_TOOL_NAME, description: "List safe opaque link ids discovered on a fetched research page.", parameters: { type: "object", additionalProperties: false, required: ["pageId"], properties: { pageId: { type: "string", minLength: 1, maxLength: 80 } } } } },
  { type: "function", function: { name: FOLLOW_PAGE_LINK_TOOL_NAME, description: "Fetch a link that was discovered on a page in the active deep-research run.", parameters: { type: "object", additionalProperties: false, required: ["pageId", "linkId"], properties: { pageId: { type: "string", minLength: 1, maxLength: 80 }, linkId: { type: "string", minLength: 1, maxLength: 120 } } } } },
];

export function availableDeepResearchTools(unlocked: boolean): DeepSeekToolDefinition[] {
  return unlocked && Boolean(openRouterApiKey()) ? DEEP_RESEARCH_TOOL_DEFINITIONS : [];
}

