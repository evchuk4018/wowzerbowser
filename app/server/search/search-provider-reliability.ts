import "server-only";

import type { SearchCandidate, SearchProviderName, SearchProviderQuery } from "./search-types";
import { runtimeConfigSnapshot } from "../config/runtime-config-service";

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

function cacheKey(provider: SearchProviderName, query: SearchProviderQuery): string {
  return JSON.stringify([
    provider,
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

function recordFailure(provider: SearchProviderName, signal?: AbortSignal): void {
  const state = circuit(provider);
  state.probeInFlight = false;
  if (signal?.aborted) return;
  state.consecutiveFailures += 1;
  if (state.consecutiveFailures >= failureThreshold()) state.openedAt = Date.now();
}

export async function searchProviderWithReliability(input: {
  provider: SearchProviderName;
  query: SearchProviderQuery;
  signal?: AbortSignal;
  execute: () => Promise<SearchCandidate[]>;
}): Promise<SearchCandidate[]> {
  const { provider, query, signal, execute } = input;
  const key = cacheKey(provider, query);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return hydrate(cached.candidates, provider, query);
  if (cached) cache.delete(key);
  if (circuitIsOpen(provider)) throw new SearchProviderCircuitOpenError(provider);

  try {
    const candidates = await execute();
    recordSuccess(provider);
    const ttl = cacheTtlMs();
    if (ttl > 0) cache.set(key, { expiresAt: Date.now() + ttl, candidates: candidates.map(cloneCandidate) });
    return hydrate(candidates, provider, query);
  } catch (error) {
    recordFailure(provider, signal);
    throw error;
  }
}

export function resetSearchProviderReliability(): void {
  cache.clear();
  circuits.clear();
}
