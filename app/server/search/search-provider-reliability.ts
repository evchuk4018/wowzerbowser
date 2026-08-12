import "server-only";

import { createHash } from "node:crypto";
import { SearchProviderBlockedError, type SearchCandidate, type SearchProviderName, type SearchProviderQuery } from "./search-types";
import { runtimeConfigSnapshot } from "../config/runtime-config-service";
import { resetSearXNGRequestControl } from "./searxng-request-control";

type CacheEntry = {
  expiresAt: number;
  candidates: SearchCandidate[];
};

type CircuitState = {
  consecutiveFailures: number;
  openedAt?: number;
  probeInFlight: boolean;
};

export class SearchProviderCircuitOpenError extends Error {
  constructor(provider: SearchProviderName) {
    super(`Search provider ${provider} is temporarily unavailable.`);
    this.name = "SearchProviderCircuitOpenError";
  }
}

const cache = new Map<string, CacheEntry>();
const circuits = new Map<SearchProviderName, CircuitState>();

function cacheTtlMs(): number {
  return runtimeConfigSnapshot().searchProviderCacheTtlMs;
}

function circuitOpenMs(): number {
  return runtimeConfigSnapshot().searchProviderCircuitOpenMs;
}

function failureThreshold(): number {
  return runtimeConfigSnapshot().searchProviderFailureThreshold;
}

function circuit(provider: SearchProviderName): CircuitState {
  const existing = circuits.get(provider);
  if (existing) return existing;
  const created: CircuitState = { consecutiveFailures: 0, probeInFlight: false };
  circuits.set(provider, created);
  return created;
}

function queryHash(query: string): string {
  return createHash("sha256").update(query).digest("hex").slice(0, 16);
}

function cacheKey(provider: SearchProviderName, namespace: string, query: SearchProviderQuery): string {
  return JSON.stringify([
    provider,
    namespace,
    query.query,
    query.relevanceQuery ?? query.query,
    query.focus,
    query.count,
    query.intent,
    query.freshness ?? "",
  ]);
}

function cloneCandidate(candidate: SearchCandidate): SearchCandidate {
  return { ...candidate, extraSnippets: [...candidate.extraSnippets] };
}

function hydrate(candidates: readonly SearchCandidate[], provider: SearchProviderName, query: SearchProviderQuery): SearchCandidate[] {
  return candidates.map((candidate) => ({
    ...cloneCandidate(candidate),
    provider,
    queryIndex: query.queryIndex,
    intent: query.intent,
  }));
}

function circuitIsOpen(provider: SearchProviderName): boolean {
  const state = circuit(provider);
  if (state.openedAt === undefined) return false;
  if (Date.now() - state.openedAt < circuitOpenMs()) return true;
  if (state.probeInFlight) return true;
  state.probeInFlight = true;
  return false;
}

function recordSuccess(provider: SearchProviderName): void {
  const state = circuit(provider);
  state.consecutiveFailures = 0;
  state.openedAt = undefined;
  state.probeInFlight = false;
}

function recordFailure(provider: SearchProviderName, signal?: AbortSignal, immediate = false): void {
  const state = circuit(provider);
  state.probeInFlight = false;
  if (signal?.aborted) return;
  state.consecutiveFailures = immediate ? failureThreshold() : state.consecutiveFailures + 1;
  if (state.consecutiveFailures >= failureThreshold()) state.openedAt = Date.now();
}

export async function searchProviderWithReliability(input: {
  provider: SearchProviderName;
  cacheNamespace?: string;
  circuitProvider?: SearchProviderName;
  query: SearchProviderQuery;
  signal?: AbortSignal;
  execute: () => Promise<SearchCandidate[]>;
}): Promise<SearchCandidate[]> {
  const { provider, query, signal, execute } = input;
  const cacheNamespace = input.cacheNamespace ?? provider;
  const circuitProvider = input.circuitProvider ?? provider;
  const key = cacheKey(provider, cacheNamespace, query);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    console.info(JSON.stringify({ event: "search_provider_cache_hit", provider, cacheNamespace, queryHash: queryHash(query.query) }));
    return hydrate(cached.candidates, provider, query);
  }
  if (cached) cache.delete(key);
  if (circuitIsOpen(circuitProvider)) {
    console.warn(JSON.stringify({ event: "search_provider_circuit_open", provider: circuitProvider, queryHash: queryHash(query.query) }));
    throw new SearchProviderCircuitOpenError(circuitProvider);
  }

  try {
    const candidates = await execute();
    recordSuccess(circuitProvider);
    const ttl = cacheTtlMs();
    if (ttl > 0) cache.set(key, { expiresAt: Date.now() + ttl, candidates: candidates.map(cloneCandidate) });
    return hydrate(candidates, provider, query);
  } catch (error) {
    recordFailure(circuitProvider, signal, error instanceof SearchProviderBlockedError);
    throw error;
  }
}

export function resetSearchProviderReliability(): void {
  cache.clear();
  circuits.clear();
  resetSearXNGRequestControl();
}
