import "server-only";
import type { ChatModelInfo } from "../../../lib/chat-protocol";
import type { OpenRouterProvider } from "../../providers/openrouter/openrouter-catalog-adapter";
import { getServerClient } from "../../auth/supabase-server-adapter";

export type CatalogCache = { models: ChatModelInfo[]; providers: OpenRouterProvider[]; fetchedAt: string };
export async function readCatalogCache(hash: string): Promise<CatalogCache | null> {
  const { data, error } = await getServerClient().from("openrouter_catalog_query_cache").select("models,providers,fetched_at").eq("query_hash", hash).maybeSingle();
  if (error) throw error;
  return data ? { models: data.models as ChatModelInfo[], providers: data.providers as OpenRouterProvider[], fetchedAt: data.fetched_at as string } : null;
}
export async function saveCatalogCache(hash: string, canonicalQuery: string, cache: CatalogCache): Promise<void> {
  const { error } = await getServerClient().from("openrouter_catalog_query_cache").upsert({ query_hash: hash, canonical_query: canonicalQuery, models: cache.models, providers: cache.providers, fetched_at: cache.fetchedAt, updated_at: new Date().toISOString() });
  if (error) throw error;
}
export async function listEnabledOpenRouterModels(ownerId: string): Promise<string[]> {
  const { data, error } = await getServerClient().from("enabled_openrouter_models").select("model").eq("owner_id", ownerId).eq("enabled", true);
  if (error) throw error;
  return (data ?? []).map((row) => row.model as string);
}
export async function setOpenRouterModelEnabled(ownerId: string, model: string, enabled: boolean): Promise<void> {
  const { error } = await getServerClient().from("enabled_openrouter_models").upsert({ owner_id: ownerId, model, enabled, updated_at: new Date().toISOString() });
  if (error) throw error;
}
