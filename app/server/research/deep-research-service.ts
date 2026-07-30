import "server-only";
import { randomUUID } from "node:crypto";
import type { ResearchBudget } from "../../../lib/chat-protocol";
import { canonicalSourceUrl } from "../../../lib/chat-citations";
import {
  rerankWithJina, searchBrave, searchCrossref, searchExa, searchGdelt, searchGitHub, searchJina,
  searchMediaWiki, searchOpenAlex, searchSemanticScholar,
} from "../../providers/research/research-search-adapters";
import { configuredKeys } from "../agent/web-api-key-pool";
import { recordUsage } from "../usage/usage-store";
import { estimatedProviderCost, researchLimits } from "./research-config";
import { decomposeResearchRequest, extractResearchClaims, verifyResearchClaims } from "./research-model";
import { fetchResearchPage } from "./research-page-service";
import { rankResearchCandidates } from "./research-ranking";
import type { FetchedResearchPage, ResearchQuery, ResearchRun, SearchCandidate } from "./research-types";

type ModelAnswer = Awaited<ReturnType<typeof import("../../providers/openrouter/openrouter-qwen-text-adapter").completeOpenRouterQwenText>>;
const host = (url: string): string => { try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } };
const modelReservation = 0.01;

function fallbackQueries(request: string, maximum: number): ResearchQuery[] {
  return [
    { query: `${request} official primary source`, intent: "official" },
    { query: `${request} latest recent`, intent: "recent", freshness: "year" },
    { query: `${request} independent analysis`, intent: "analysis" },
    { query: `${request} community experiences discussion`, intent: "community" },
    { query: `${request} criticism contradicting evidence`, intent: "contradicting" },
  ].slice(0, maximum) as ResearchQuery[];
}

async function specialistSearch(query: ResearchQuery, index: number): Promise<SearchCandidate[]> {
  const academic = query.intent === "academic" || /\b(?:academic|paper|papers|study|studies|journal|doi|citation)\b/i.test(query.query);
  const developer = query.intent === "developer" || /\b(?:github|repository|software|library|framework|release|issue|code)\b/i.test(query.query);
  if (academic) {
    const results = await Promise.allSettled([searchOpenAlex(query, index), searchCrossref(query, index), searchSemanticScholar(query, index)]);
    return results.flatMap((item) => item.status === "fulfilled" ? item.value : []);
  }
  if (developer) return searchGitHub(query, index).catch(() => []);
  if (query.intent === "recent") return searchGdelt(query, index).catch(() => []);
  if (query.intent === "official") return searchMediaWiki(query, index).catch(() => []);
  return [];
}

async function executeQuery(query: ResearchQuery, index: number, run: ResearchRun): Promise<SearchCandidate[]> {
  const braveConfigured = configuredKeys("brave").length > 0;
  const braveCost = estimatedProviderCost("brave");
  const mayUseBrave = braveConfigured && run.budget.estimatedCostUsd + braveCost <= run.limits.maxEstimatedCostUsd;
  if (mayUseBrave) run.budget.estimatedCostUsd += braveCost;
  const [primary, specialist] = await Promise.allSettled([
    mayUseBrave ? searchBrave(query, index) : Promise.resolve([]),
    specialistSearch(query, index),
  ]);
  let results = primary.status === "fulfilled" ? primary.value : [];
  if (results.length < 5 && braveConfigured && run.budget.estimatedCostUsd + braveCost <= run.limits.maxEstimatedCostUsd) {
    run.budget.estimatedCostUsd += braveCost;
    results.push(...await searchBrave(query, index, 1).catch(() => []));
  }
  if (results.length < 5) results = [...results, ...await searchJina(query, index).catch(() => [])];
  const exaCost = estimatedProviderCost("exa");
  if (results.length < 5 && configuredKeys("exa").length > 0 && run.budget.estimatedCostUsd + exaCost <= run.limits.maxEstimatedCostUsd) {
    run.budget.estimatedCostUsd += exaCost;
    results.push(...await searchExa(query, index).catch(() => []));
  }
  if (specialist.status === "fulfilled") results.push(...specialist.value);
  return results;
}

function evidenceText(pages: Iterable<FetchedResearchPage>, maximumTokens: number): string {
  const maximumCharacters = maximumTokens * 4;
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

  const free = await Promise.allSettled(selected.map((candidate) => fetchResearchPage(candidate.url, run.request, { allowExa: false, allowBrowser: false })));
  const failures: SearchCandidate[] = [];
  free.forEach((result, index) => {
    if (result.status === "fulfilled") run.pages.set(result.value.page.id, result.value.page);
    else failures.push(selected[index]);
  });
  for (const provider of ["exa", "browser"] as const) {
    if (!failures.length) break;
    const cost = estimatedProviderCost(provider);
    const affordable = Math.min(failures.length, Math.floor((run.limits.maxEstimatedCostUsd - run.budget.estimatedCostUsd) / Math.max(cost, Number.EPSILON)));
    if (affordable <= 0) break;
    const batch = failures.splice(0, affordable);
    const results = await Promise.allSettled(batch.map((candidate) => fetchResearchPage(candidate.url, run.request, { allowExa: provider === "exa", allowBrowser: provider === "browser" })));
    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        run.pages.set(result.value.page.id, result.value.page);
        if (result.value.paidProvider) run.budget.estimatedCostUsd += estimatedProviderCost(result.value.paidProvider);
      } else failures.push(batch[index]);
    });
  }
  run.budget.fetchedPages = run.pages.size;
  for (const page of run.pages.values()) for (const link of page.links) run.allowedUrls.add(canonicalSourceUrl(link.url));
}

export async function performDeepResearch(input: {
  ownerId: string; conversationId: string; jobId: string; request: string; signal?: AbortSignal;
}): Promise<ResearchRun> {
  const limits = researchLimits();
  const budget: ResearchBudget = { searches: 0, fetchedPages: 0, followUpSearches: 0, evidenceTokens: 0, modelCalls: 0, estimatedCostUsd: 0 };
  const run: ResearchRun = { id: `research_${randomUUID()}`, request: input.request, allowedUrls: new Set(), pages: new Map(), claims: [], sources: [], budget, limits, warnings: [] };
  const onAnswer = async (answer: ModelAnswer) => {
    budget.modelCalls += 1;
    budget.estimatedCostUsd += answer.exactCostUsd ?? modelReservation;
    await recordUsage({ ownerId: input.ownerId, provider: "openrouter", model: answer.model, requestKind: "deep_research", requestId: input.jobId, round: budget.modelCalls, usage: answer.usage ?? answer.estimatedUsage, source: answer.usage ? "exact" : "estimated", exactCostUsd: answer.exactCostUsd, unpriced: answer.exactCostUsd === undefined, conversationId: input.conversationId, jobId: input.jobId }).catch(() => undefined);
  };

  const initialMaximum = Math.max(1, Math.min(5, limits.maxSearches));
  let queries: ResearchQuery[];
  try {
    if (budget.estimatedCostUsd + modelReservation > limits.maxEstimatedCostUsd) throw new Error("cost");
    queries = await decomposeResearchRequest(input.request, initialMaximum, input.signal, onAnswer);
  } catch {
    queries = fallbackQueries(input.request, initialMaximum);
    run.warnings.push("Query decomposition used the deterministic fallback.");
  }
  if (queries.length < Math.min(4, initialMaximum)) queries = fallbackQueries(input.request, initialMaximum);
  queries = queries.slice(0, limits.maxSearches);
  budget.searches = queries.length;
  let candidates = (await Promise.all(queries.map((query, index) => executeQuery(query, index, run)))).flat();
  candidates = await rerankWithJina(input.request, candidates).catch(() => candidates);
  let ranked = rankResearchCandidates(candidates);
  await fetchRankedPages(run, ranked);
  if (run.pages.size < 2) run.warnings.push("Research stopped with fewer than two readable sources.");

  let evidence = evidenceText(run.pages.values(), limits.maxEvidenceTokens);
  budget.evidenceTokens = Math.ceil(evidence.length / 4);
  if (run.pages.size && budget.modelCalls < limits.maxModelCalls && budget.estimatedCostUsd + modelReservation <= limits.maxEstimatedCostUsd) {
    run.claims = await extractResearchClaims(input.request, evidence, input.signal, onAnswer).catch(() => []);
  }
  let followUps: ResearchQuery[] = [];
  if (run.claims.length && budget.modelCalls < limits.maxModelCalls && budget.estimatedCostUsd + modelReservation <= limits.maxEstimatedCostUsd) {
    const verified = await verifyResearchClaims(input.request, run.claims, evidence, input.signal, onAnswer).catch(() => ({ claims: run.claims, followUpQueries: [] }));
    run.claims = verified.claims;
    followUps = verified.followUpQueries;
  }
  const remainingSearches = limits.maxSearches - budget.searches;
  followUps = followUps.slice(0, Math.min(limits.maxFollowUpSearches, remainingSearches));
  if (followUps.length) {
    const before = run.pages.size;
    budget.followUpSearches = followUps.length;
    budget.searches += followUps.length;
    const additional = (await Promise.all(followUps.map((query, index) => executeQuery(query, queries.length + index, run)))).flat();
    ranked = rankResearchCandidates([...ranked, ...additional]);
    await fetchRankedPages(run, ranked.filter((candidate) => ![...run.pages.values()].some((page) => page.source.url === candidate.url)));
    if (run.pages.size - before < 2) run.warnings.push("Follow-up searches reached early stopping because they produced little new evidence.");
    evidence = evidenceText(run.pages.values(), limits.maxEvidenceTokens);
    budget.evidenceTokens = Math.ceil(evidence.length / 4);
    if (run.pages.size > before && budget.modelCalls < limits.maxModelCalls && budget.estimatedCostUsd + modelReservation <= limits.maxEstimatedCostUsd) {
      run.claims = await extractResearchClaims(input.request, evidence, input.signal, onAnswer).catch(() => run.claims);
    }
  }
  run.sources = [...new Map([...candidates, ...run.pages.values()].map((item) => {
    const source = "source" in item ? item.source : item;
    return [source.id, source] as const;
  })).values()];
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
