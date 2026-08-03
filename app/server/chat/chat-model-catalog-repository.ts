import "server-only";
import type { ChatModelInfo } from "../../../lib/chat-protocol";
import type { OpenRouterProvider } from "../../providers/openrouter/openrouter-catalog-adapter";
import { databaseOwnerId, isoTimestamp, jsonb, query } from "../database/database";

export type CatalogCache = { models: ChatModelInfo[]; providers: OpenRouterProvider[]; fetchedAt: string };
export async function readCatalogCache(hash: string): Promise<CatalogCache | null> {
  const [data] = await query<{ models: unknown; providers: unknown; fetched_at: unknown }>("select models,providers,fetched_at from openrouter_catalog_query_cache where query_hash = $1", [hash]);
  return data ? { models: data.models as ChatModelInfo[], providers: data.providers as OpenRouterProvider[], fetchedAt: isoTimestamp(data.fetched_at) } : null;
}
export async function saveCatalogCache(hash: string, canonicalQuery: string, cache: CatalogCache): Promise<void> {
  await query(`insert into openrouter_catalog_query_cache (query_hash,canonical_query,models,providers,fetched_at,updated_at)
    values ($1,$2,$3::jsonb,$4::jsonb,$5,$6)
    on conflict (query_hash) do update set canonical_query=excluded.canonical_query,models=excluded.models,providers=excluded.providers,fetched_at=excluded.fetched_at,updated_at=excluded.updated_at`,
    [hash, canonicalQuery, jsonb(cache.models), jsonb(cache.providers), cache.fetchedAt, new Date().toISOString()]);
}
export async function listEnabledOpenRouterModels(ownerId: string): Promise<string[]> {
  const rows = await query<{ model: string }>("select model from enabled_openrouter_models where owner_id=$1 and enabled=true order by model", [databaseOwnerId(ownerId)]);
  return rows.map((row) => row.model);
}
export async function setOpenRouterModelEnabled(ownerId: string, model: string, enabled: boolean): Promise<void> {
  await query(`insert into enabled_openrouter_models(owner_id,model,enabled,updated_at) values($1,$2,$3,$4)
    on conflict(owner_id,model) do update set enabled=excluded.enabled,updated_at=excluded.updated_at`, [databaseOwnerId(ownerId), model, enabled, new Date().toISOString()]);
}
