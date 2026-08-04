import "server-only";
import type { ChatToolCall, ChatToolResult } from "../../../lib/chat-protocol";
import { canonicalSourceUrl } from "../../../lib/chat-citations";
import { performDeepResearch, researchStopReason } from "../research/deep-research-service";
import { fetchResearchPage } from "../research/research-page-service";
import type { ResearchRun } from "../research/research-types";
import {
  DEEP_RESEARCH_SEARCH_TOOL_NAME, FIND_IN_PAGE_TOOL_NAME, FOLLOW_PAGE_LINK_TOOL_NAME,
  LIST_PAGE_LINKS_TOOL_NAME,
} from "./deep-research-tool-manifest";

export type DeepResearchToolContext = {
  ownerId: string;
  conversationId: string;
  jobId: string;
  signal?: AbortSignal;
  activeRun: ResearchRun | null;
};

const fail = (call: ChatToolCall, stderr: string): ChatToolResult => ({ id: call.id, name: call.name, ok: false, stdout: "", stderr });
const parse = (call: ChatToolCall): Record<string, unknown> => {
  const value = JSON.parse(call.arguments || "{}");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid deep research tool arguments.");
  return value as Record<string, unknown>;
};
const required = (input: Record<string, unknown>, key: string, maximum: number): string => {
  if (typeof input[key] !== "string" || !input[key].trim() || input[key].trim().length > maximum) throw new Error(`${key} is required.`);
  return input[key].trim();
};

export async function executeDeepResearchTool(call: ChatToolCall, context: DeepResearchToolContext): Promise<{ result: ChatToolResult; activeRun: ResearchRun | null }> {
  const startedAt = Date.now();
  try {
    const input = parse(call);
    if (call.name === DEEP_RESEARCH_SEARCH_TOOL_NAME) {
      const request = required(input, "request", 20_000);
      const run = await performDeepResearch({ ownerId: context.ownerId, conversationId: context.conversationId, jobId: context.jobId, request, signal: context.signal });
      return {
        activeRun: run,
        result: {
          id: call.id, name: call.name, ok: true, stdout: "", stderr: "", durationMs: Date.now() - startedAt,
          research: {
            kind: "ledger", runId: run.id, request, claims: run.claims, sources: run.sources,
            pages: [...run.pages.values()].map((page) => ({ id: page.id, source: page.source, fetched: true, extractor: page.extractor })),
            budget: run.budget, stopReason: researchStopReason(run), warnings: run.warnings,
          },
        },
      };
    }
    const run = context.activeRun;
    if (!run) return { activeRun: null, result: fail(call, "No active deep research run.") };
    const pageId = required(input, "pageId", 80);
    const page = run.pages.get(pageId);
    if (!page) return { activeRun: run, result: fail(call, "The page is not part of the active research run.") };
    if (call.name === FIND_IN_PAGE_TOOL_NAME) {
      const query = required(input, "query", 400);
      const terms = query.toLowerCase().split(/\W+/).filter((term) => term.length > 2);
      const matches = [...page.markdown.matchAll(/.{0,240}(?:\n|$)/g)].map((match) => ({ excerpt: match[0].trim(), start: match.index ?? 0 })).filter((match) => match.excerpt && terms.some((term) => match.excerpt.toLowerCase().includes(term))).slice(0, 20);
      return { activeRun: run, result: { id: call.id, name: call.name, ok: true, stdout: "", stderr: "", durationMs: Date.now() - startedAt, research: { kind: "matches", runId: run.id, pageId, query, matches } } };
    }
    if (call.name === LIST_PAGE_LINKS_TOOL_NAME) {
      return { activeRun: run, result: { id: call.id, name: call.name, ok: true, stdout: "", stderr: "", durationMs: Date.now() - startedAt, research: { kind: "links", runId: run.id, pageId, links: page.links.slice(0, 200).map(({ id, text }) => ({ id, text })) } } };
    }
    if (call.name === FOLLOW_PAGE_LINK_TOOL_NAME) {
      if (run.pages.size >= run.limits.maxFetchedPages) return { activeRun: run, result: fail(call, "The research page limit has been reached.") };
      const linkId = required(input, "linkId", 120);
      const link = page.links.find((item) => item.id === linkId);
      if (!link || !run.allowedUrls.has(canonicalSourceUrl(link.url))) return { activeRun: run, result: fail(call, "The link is not allowed for this research run.") };
      const domain = new URL(link.url).hostname;
      if ([...run.pages.values()].filter((item) => new URL(item.source.url).hostname === domain).length >= run.limits.maxPagesPerDomain) return { activeRun: run, result: fail(call, "The research domain fetch limit has been reached.") };
      let fetched;
      try {
        fetched = await fetchResearchPage(link.url);
      } catch {
        return { activeRun: run, result: fail(call, "The selected page could not be retrieved by the self-hosted page service.") };
      }
      run.pages.set(fetched.page.id, fetched.page);
      run.budget.fetchedPages = run.pages.size;
      run.sources = [...new Map([...run.sources, fetched.page.source].map((source) => [source.id, source])).values()];
      for (const child of fetched.page.links) run.allowedUrls.add(canonicalSourceUrl(child.url));
      return { activeRun: run, result: { id: call.id, name: call.name, ok: true, stdout: "", stderr: "", durationMs: Date.now() - startedAt, research: { kind: "page", runId: run.id, page: { id: fetched.page.id, source: fetched.page.source, fetched: true, extractor: fetched.page.extractor }, markdown: fetched.page.markdown.slice(0, 24_000) } } };
    }
    return { activeRun: run, result: fail(call, `Unknown deep research tool: ${call.name}`) };
  } catch (error) {
    return { activeRun: context.activeRun, result: fail(call, error instanceof Error ? error.message : "Deep research failed.") };
  }
}
