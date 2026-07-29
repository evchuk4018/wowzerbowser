import "server-only";
import { DEFAULT_CHAT_MODELS, chatModelIdentity, type ChatModelInfo, type ChatModelRef } from "../../../lib/chat-protocol";
import { fetchOpenRouterModels, fetchOpenRouterProviders, OpenRouterError } from "../../providers/openrouter/openrouter-catalog-adapter";
import { canonicalCatalogQuery, catalogQueryHash, parseCatalogQuery } from "./chat-model-catalog-query";
import { listEnabledOpenRouterModels, readCatalogCache, saveCatalogCache, setOpenRouterModelEnabled } from "./chat-model-catalog-repository";

const TTL_MS = 15 * 60 * 1000;
export class ChatModelAuthorizationError extends Error {}
export async function discoverChatModels(ownerId: string, params: URLSearchParams) {
  const query = parseCatalogQuery(params);
  const hash = catalogQueryHash(query);
  const cached = await readCatalogCache(hash);
  const fresh = cached && Date.now() - Date.parse(cached.fetchedAt) < TTL_MS;
  let source = cached;
  let stale = Boolean(cached && !fresh);
  let providerError: string | null = null;
  if (!fresh) {
    try {
      const [models, providers] = await Promise.all([fetchOpenRouterModels(query.upstream), fetchOpenRouterProviders()]);
      source = { models, providers, fetchedAt: new Date().toISOString() };
      stale = false;
      await saveCatalogCache(hash, canonicalCatalogQuery(query), source).catch(() => undefined);
    } catch (error) {
      providerError = error instanceof Error ? error.message : "OpenRouter is unavailable.";
      if (!source) throw error;
    }
  }
  if (!source) throw new OpenRouterError("OpenRouter catalog is unavailable.", 503);
  const enabled = new Set(await listEnabledOpenRouterModels(ownerId));
  const models = query.enabled === "enabled" ? source.models.filter((model) => enabled.has(model.ref.model)) : source.models;
  const authors = [...new Set(source.models.map((item) => item.author).filter((item): item is string => Boolean(item)))].sort();
  const architectures = [...new Set(source.models.map((item) => item.architecture).filter((item): item is string => Boolean(item)))].sort();
  return {
    models: models.map((model) => ({ ...model, enabled: enabled.has(model.ref.model) })),
    total: models.length, appliedFilters: query.applied,
    facets: { authors, architectures, providers: source.providers },
    cache: { fetchedAt: source.fetchedAt, stale, ttlSeconds: TTL_MS / 1000 },
    providerError,
  };
}
export async function composerChatModels(ownerId: string): Promise<ChatModelInfo[]> {
  const enabled = new Set(await listEnabledOpenRouterModels(ownerId));
  if (!enabled.size) return DEFAULT_CHAT_MODELS;
  const catalog = await discoverChatModels(ownerId, new URLSearchParams());
  return [...DEFAULT_CHAT_MODELS, ...catalog.models.filter((item) => item.enabled && item.toolSupport && item.outputModalities.includes("text"))];
}

export function isVisionChatModel(model: ChatModelInfo): boolean {
  return model.ref.provider === "openrouter"
    && model.inputModalities.includes("image")
    && model.outputModalities.includes("text")
    && model.supportedParameters.includes("structured_outputs");
}

export async function visionChatModels(ownerId: string): Promise<ChatModelInfo[]> {
  const catalog = await discoverChatModels(ownerId, new URLSearchParams({ input_modalities: "image" }));
  const enabled = new Set(await listEnabledOpenRouterModels(ownerId));
  return catalog.models.filter((model) => enabled.has(model.ref.model) && isVisionChatModel(model));
}

export async function configuredVisionModel(ownerId: string): Promise<string | null> {
  const { getChatUserPreferences } = await import("./chat-user-preferences-store");
  const preference = await getChatUserPreferences(ownerId);
  const ref = preference.visionModel;
  if (!ref) return null;
  const models = await visionChatModels(ownerId);
  return models.some((model) => chatModelIdentity(model.ref) === chatModelIdentity(ref)) ? ref.model : null;
}
export async function enableChatModel(ownerId: string, ref: ChatModelRef, enabled: boolean) {
  if (ref.provider !== "openrouter") throw new ChatModelAuthorizationError("Built-in models cannot be disabled.");
  const catalog = await discoverChatModels(ownerId, new URLSearchParams({ q: ref.model }));
  if (!catalog.models.some((item) => item.ref.model === ref.model)) throw new ChatModelAuthorizationError("Model is not eligible.");
  await setOpenRouterModelEnabled(ownerId, ref.model, enabled);
}
export async function authorizeChatModel(ownerId: string, ref: ChatModelRef): Promise<ChatModelInfo> {
  const builtIn = DEFAULT_CHAT_MODELS.find((item) => chatModelIdentity(item.ref) === chatModelIdentity(ref));
  if (builtIn) return builtIn;
  if (ref.provider !== "openrouter") throw new ChatModelAuthorizationError("Model is not supported.");
  const enabled = new Set(await listEnabledOpenRouterModels(ownerId));
  if (!enabled.has(ref.model)) throw new ChatModelAuthorizationError("Model is not enabled.");
  const catalog = await discoverChatModels(ownerId, new URLSearchParams({ q: ref.model }));
  const model = catalog.models.find((item) => item.ref.model === ref.model);
  if (!model) throw new ChatModelAuthorizationError("Model is no longer eligible.");
  return model;
}
