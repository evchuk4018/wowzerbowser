import "server-only";
import { randomUUID } from "node:crypto";
import type { ChatResearchTraceEntry, ChatUsage, ResearchBudget } from "../../../lib/chat-protocol";
import { canonicalSourceUrl, sourceForUrl, type ChatSource } from "../../../lib/chat-citations";
import { SearchUnavailableError, searchSelfHosted } from "../search/search-service";
import { recordPromptUsage } from "../usage/prompt-cost-service";
import { ReasoningTitleCoordinator, type ReasoningTitleUsage } from "../chat/reasoning-title-service";
import { researchLimits } from "./research-config";
import { runtimeConfigSnapshot } from "../config/runtime-config-service";
import { decomposeResearchRequest, extractResearchClaims, verifyResearchClaims } from "./research-model";
import { fetchResearchPage } from "./research-page-service";
import { rankResearchCandidates } from "./research-ranking";
import type { FetchedResearchPage, ResearchQuery, ResearchRun, SearchCandidate } from "./research-types";

type ModelAnswer = Awaited<ReturnType<typeof import("../../providers/openrouter/openrouter-qwen-text-adapter").completeOpenRouterQwenText>>;
export type ResearchModelAnswer = ModelAnswer;
const host = (url: string): string => { try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } };
const modelReservation = 0.01;

export type ResearchTrace = ChatResearchTraceEntry;
export type ResearchTraceStage = "query_planning" | "searching" | "fetching" | "claim_extraction" | "verification" | "follow_up" | "synthesis";
export type ResearchTraceOperation = "started" | "completed" | "fallback" | "failed" | "skipped";
export type ResearchProgressUpdate = {
  trace?: ResearchTrace[];
  summary?: string;
  summaryRevision?: number;
};
export type ResearchProgressCallback = (update: ResearchProgressUpdate) => Promise<void> | void;

export type ResearchUsageAnswer = {
  model: string;
  usage: ChatUsage | null;
  estimatedUsage: ChatUsage;
  exactCostUsd?: number;
};

export async function recordResearchModelUsage(input: {
  ownerId: string;
  conversationId: string;
  jobId: string;
  requestId?: string;
  requestKind: "deep_research" | "reasoning_summary";
  round: number;
  answer: ResearchUsageAnswer;
}): Promise<void> {
  const usage = input.answer.usage ?? input.answer.estimatedUsage;
  await recordPromptUsage({
    ownerId: input.ownerId,
    provider: "openrouter",
    model: input.answer.model,
    requestKind: input.requestKind,
    requestId: input.requestId ?? input.jobId,
    round: input.round,
    usage,
    source: input.answer.usage || input.answer.exactCostUsd !== undefined ? "exact" : "estimated",
    exactCostUsd: input.answer.exactCostUsd,
    unpriced: input.answer.exactCostUsd === undefined,
    conversationId: input.conversationId,
    jobId: input.jobId,
  }).catch(() => undefined);
}

const TRACE_TITLES: Record<ResearchTraceStage, string> = {
  query_planning: "Planning research queries",
  searching: "Searching approved sources",
  fetching: "Fetching readable sources",
  claim_extraction: "Extracting supported claims",
  verification: "Verifying research claims",
  follow_up: "Checking consequential gaps",
  synthesis: "Synthesizing research findings",
};

async function emitProgress(callback: ResearchProgressCallback | undefined, update: ResearchProgressUpdate): Promise<void> {
  try {
    await callback?.(update);
  } catch {
    // Trace delivery is presentation-only and must not affect research.
  }
}

export class ResearchTraceCoordinator {
  private traceCount = 0;
  private summaryRevision = 0;
  private reasoningCharacters = 0;
  private readonly titleCoordinator: ReasoningTitleCoordinator;
  private readonly actorId: string;
  private readonly onUpdate?: ResearchProgressCallback;
  private readonly onReasoningDelta?: (delta: string) => Promise<void> | void;

  constructor(input: {
    actorId: string;
    signal?: AbortSignal;
    onUpdate?: ResearchProgressCallback;
    onReasoningDelta?: (delta: string) => Promise<void> | void;
    onSummaryUsage?: (usage: ReasoningTitleUsage) => Promise<void>;
  }) {
    this.actorId = input.actorId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "research";
    this.onUpdate = input.onUpdate;
    this.onReasoningDelta = input.onReasoningDelta;
    const signal = input.signal ?? new AbortController().signal;
    this.titleCoordinator = new ReasoningTitleCoordinator({
      signal,
      onUsage: input.onSummaryUsage,
      emit: async (event) => {
        if (event.type !== "phase_summary" || !event.summary.trim()) return;
        this.summaryRevision += 1;
        await emitProgress(this.onUpdate, { summary: event.summary.slice(0, 120), summaryRevision: this.summaryRevision });
      },
    });
  }

  async appendReasoning(delta: string): Promise<void> {
    if (!delta || this.reasoningCharacters >= 12_000) return;
    const bounded = delta.slice(0, 12_000 - this.reasoningCharacters);
    this.reasoningCharacters += bounded.length;
    this.titleCoordinator.append(bounded);
    await this.onReasoningDelta?.(bounded);
  }

  async update(stage: ResearchTraceStage, operation: ResearchTraceOperation, status: ResearchTrace["status"] = operation === "failed" ? "failed" : operation === "completed" ? "completed" : "running"): Promise<void> {
    if (this.traceCount >= 64) return;
    this.traceCount += 1;
    this.summaryRevision += 1;
    await emitProgress(this.onUpdate, {
      trace: [this.trace(stage, operation, status)],
      summary: TRACE_TITLES[stage],
      summaryRevision: this.summaryRevision,
    });
  }

  async finish(): Promise<void> {
    await this.titleCoordinator.finish().catch(() => undefined);
  }

  cancel(): void {
    this.titleCoordinator.cancel();
  }

  private trace(stage: ResearchTraceStage, operation: ResearchTraceOperation, status: ResearchTrace["status"] = operation === "failed" ? "failed" : operation === "completed" ? "completed" : "running"): ResearchTrace {
    return {
      id: `${this.actorId}-${Math.max(1, this.traceCount)}`.slice(0, 96),
      kind: "stage",
      label: TRACE_TITLES[stage],
      status,
      ...(operation === "started" ? {} : { detail: operation }),
    };
  }
}

function publicSource(source: ChatSource): ChatSource {
  return sourceForUrl({ title: source.title, url: source.url, snippet: source.snippet, publishedAt: source.publishedAt });
}

function fallbackQueries(request: string, maximum: number): ResearchQuery[] {
  return [
    { query: `${request} official primary source`, intent: "official" },
    { query: `${request} latest recent`, intent: "recent", freshness: "year" },
    { query: `${request} independent analysis`, intent: "analysis" },
    { query: `${request} community experiences discussion`, intent: "community" },
    { query: `${request} criticism contradicting evidence`, intent: "contradicting" },
  ].slice(0, maximum) as ResearchQuery[];
}

function focusForIntent(intent: ResearchQuery["intent"]): "general" | "news" | "community" | "reference" {
  if (intent === "recent") return "news";
  if (intent === "community") return "community";
  if (intent === "official" || intent === "academic") return "reference";
  return "general";
}

async function executeQuery(query: ResearchQuery, index: number, run: ResearchRun): Promise<SearchCandidate[]> {
  try {
    return await searchSelfHosted({
      query: query.query,
      focus: focusForIntent(query.intent),
      freshness: query.freshness,
      queryIndex: index,
      intent: query.intent,
    });
  } catch (error) {
    run.warnings.push(error instanceof SearchUnavailableError
      ? `Search could not be verified for query ${index + 1}: ${error.message}`
      : `Self-hosted search providers returned no relevant results for query ${index + 1}.`);
    return [];
  }
}

function evidenceText(pages: Iterable<FetchedResearchPage>, maximumTokens: number, configuredMaximumCharacters: number): string {
  const maximumCharacters = Math.min(maximumTokens * 4, configuredMaximumCharacters, 250_000);
  let output = "";
  for (const page of pages) {
    const block = `<source id="${page.source.id}" url="${page.source.url}" date="${page.source.publishedAt ?? ""}">\n${page.markdown}\n</source>\n`;
    if (output.length + block.length > maximumCharacters) {
      output += block.slice(0, Math.max(0, maximumCharacters - output.length));
      break;
    }
    output += block;
  }
  return output;
}

async function fetchRankedPages(run: ResearchRun, candidates: SearchCandidate[]): Promise<void> {
  const domains = new Map<string, number>();
  for (const page of run.pages.values()) domains.set(host(page.source.url), (domains.get(host(page.source.url)) ?? 0) + 1);
  const remainingPages = Math.max(0, run.limits.maxFetchedPages - run.pages.size);
  const selected = candidates.filter((candidate) => {
    const domain = host(candidate.url);
    const count = domains.get(domain) ?? 0;
    if (count >= run.limits.maxPagesPerDomain) return false;
    domains.set(domain, count + 1);
    run.allowedUrls.add(canonicalSourceUrl(candidate.url));
    return true;
  }).slice(0, remainingPages);

  const results = await Promise.allSettled(selected.map((candidate) => fetchResearchPage(candidate.url)));
  results.forEach((result) => {
    if (result.status === "fulfilled") run.pages.set(result.value.page.id, result.value.page);
  });
  run.budget.fetchedPages = run.pages.size;
  for (const page of run.pages.values()) for (const link of page.links) run.allowedUrls.add(canonicalSourceUrl(link.url));
}

export async function performDeepResearch(input: {
  ownerId: string; conversationId: string; jobId: string; request: string; signal?: AbortSignal; onUpdate?: ResearchProgressCallback;
}): Promise<ResearchRun> {
  const limits = researchLimits();
  const configuration = runtimeConfigSnapshot();
  const budget: ResearchBudget = { searches: 0, fetchedPages: 0, followUpSearches: 0, evidenceTokens: 0, modelCalls: 0, estimatedCostUsd: 0 };
  const run: ResearchRun = { id: `research_${randomUUID()}`, request: input.request, allowedUrls: new Set(), pages: new Map(), claims: [], sources: [], budget, limits, warnings: [] };
  const trace = new ResearchTraceCoordinator({
    actorId: input.jobId,
    signal: input.signal,
    onUpdate: input.onUpdate,
    onSummaryUsage: async (usage) => recordResearchModelUsage({
      ownerId: input.ownerId,
      conversationId: input.conversationId,
      jobId: input.jobId,
      requestKind: "reasoning_summary",
      round: 1_000_000 + usage.phase * 100_000 + usage.revision,
      answer: usage,
    }),
  });
  const onAnswer = async (answer: ModelAnswer) => {
    budget.modelCalls += 1;
    budget.estimatedCostUsd += answer.exactCostUsd ?? modelReservation;
    await recordResearchModelUsage({ ownerId: input.ownerId, conversationId: input.conversationId, jobId: input.jobId, requestKind: "deep_research", round: budget.modelCalls, answer });
  };

  const initialMaximum = Math.max(1, Math.min(5, limits.maxSearches));
  let queries: ResearchQuery[];
  await trace.update("query_planning", "started");
  try {
    if (budget.estimatedCostUsd + modelReservation > limits.maxEstimatedCostUsd) throw new Error("cost");
    queries = await decomposeResearchRequest(input.request, initialMaximum, input.signal, onAnswer, (delta) => trace.appendReasoning(delta));
    await trace.update("query_planning", "completed", "completed");
  } catch {
    queries = fallbackQueries(input.request, initialMaximum);
    run.warnings.push("Query decomposition used the deterministic fallback.");
    await trace.update("query_planning", "fallback", "completed");
  }
  if (queries.length < Math.min(4, initialMaximum)) queries = fallbackQueries(input.request, initialMaximum);
  queries = queries.slice(0, limits.maxSearches);
  budget.searches = queries.length;
  await trace.update("searching", "started");
  const candidates = (await Promise.all(queries.map((query, index) => executeQuery(query, index, run)))).flat();
  await trace.update("searching", "completed", "completed");
  let ranked = rankResearchCandidates(candidates);
  await trace.update("fetching", "started");
  await fetchRankedPages(run, ranked);
  await trace.update("fetching", "completed", "completed");
  if (run.pages.size < 2) run.warnings.push("Research stopped with fewer than two readable sources.");

  let evidence = evidenceText(run.pages.values(), limits.maxEvidenceTokens, configuration.deepResearchMaxEvidenceCharacters);
  budget.evidenceTokens = Math.ceil(evidence.length / 4);
  if (run.pages.size && budget.modelCalls < limits.maxModelCalls && budget.estimatedCostUsd + modelReservation <= limits.maxEstimatedCostUsd) {
    await trace.update("claim_extraction", "started");
    try {
      run.claims = await extractResearchClaims(input.request, evidence, input.signal, onAnswer, (delta) => trace.appendReasoning(delta));
      await trace.update("claim_extraction", "completed", "completed");
    } catch {
      await trace.update("claim_extraction", "failed", "failed");
      run.claims = [];
    }
  } else {
    await trace.update("claim_extraction", "skipped", "completed");
  }
  let followUps: ResearchQuery[] = [];
  if (run.claims.length && budget.modelCalls < limits.maxModelCalls && budget.estimatedCostUsd + modelReservation <= limits.maxEstimatedCostUsd) {
    await trace.update("verification", "started");
    try {
      const verified = await verifyResearchClaims(input.request, run.claims, evidence, input.signal, onAnswer, (delta) => trace.appendReasoning(delta));
      run.claims = verified.claims;
      followUps = verified.followUpQueries;
      await trace.update("verification", "completed", "completed");
    } catch {
      await trace.update("verification", "failed", "failed");
      followUps = [];
    }
  } else {
    await trace.update("verification", "skipped", "completed");
  }
  const remainingSearches = limits.maxSearches - budget.searches;
  followUps = followUps.slice(0, Math.min(limits.maxFollowUpSearches, remainingSearches));
  if (followUps.length) {
    await trace.update("follow_up", "started");
    const before = run.pages.size;
    budget.followUpSearches = followUps.length;
    budget.searches += followUps.length;
    const additional = (await Promise.all(followUps.map((query, index) => executeQuery(query, queries.length + index, run)))).flat();
    ranked = rankResearchCandidates([...ranked, ...additional]);
    await fetchRankedPages(run, ranked.filter((candidate) => ![...run.pages.values()].some((page) => page.source.url === candidate.url)));
    if (run.pages.size - before < 2) run.warnings.push("Follow-up searches reached early stopping because they produced little new evidence.");
    evidence = evidenceText(run.pages.values(), limits.maxEvidenceTokens, configuration.deepResearchMaxEvidenceCharacters);
    budget.evidenceTokens = Math.ceil(evidence.length / 4);
    if (run.pages.size > before && budget.modelCalls < limits.maxModelCalls && budget.estimatedCostUsd + modelReservation <= limits.maxEstimatedCostUsd) {
      try {
        run.claims = await extractResearchClaims(input.request, evidence, input.signal, onAnswer, (delta) => trace.appendReasoning(delta));
      } catch {
        // Preserve the verified claims when follow-up extraction is unavailable.
      }
    }
    await trace.update("follow_up", "completed", "completed");
  } else {
    await trace.update("follow_up", "skipped", "completed");
  }
  run.sources = [...new Map([...candidates, ...run.pages.values()].map((item) => {
    const source = "source" in item ? item.source : item;
    const normalized = publicSource(source);
    return [normalized.id, normalized] as const;
  })).values()];
  await trace.finish();
  return run;
}

export function researchStopReason(run: ResearchRun): "complete" | "early_stopping" | "search_limit" | "page_limit" | "token_limit" | "model_limit" | "cost_limit" {
  if (run.budget.estimatedCostUsd >= run.limits.maxEstimatedCostUsd) return "cost_limit";
  if (run.budget.evidenceTokens >= run.limits.maxEvidenceTokens) return "token_limit";
  if (run.budget.fetchedPages >= run.limits.maxFetchedPages) return "page_limit";
  if (run.budget.searches >= run.limits.maxSearches && run.budget.followUpSearches > 0) return "search_limit";
  if (run.budget.modelCalls >= run.limits.maxModelCalls) return "model_limit";
  if (run.warnings.some((warning) => /early stopping|fewer than two/i.test(warning))) return "early_stopping";
  return "complete";
}
