import "server-only";
import { DEFAULT_CHAT_MODELS, chatModelIdentity, type ChatModelInfo, type ChatModelRef } from "../../../lib/chat-protocol";
import { fetchOpenCodeModels } from "../../providers/opencode/opencode-catalog-adapter";
import { fetchOpenRouterModels, fetchOpenRouterProviders, OpenRouterError } from "../../providers/openrouter/openrouter-catalog-adapter";
import { deterministicChatModelInfo, deterministicProviderEnabled } from "../../providers/deterministic/deterministic-chat-adapter";
import { canonicalCatalogQuery, catalogQueryHash, parseCatalogQuery } from "./chat-model-catalog-query";
import {
  listEnabledOpenCodeModels,
  listEnabledOpenRouterModels,
  readCatalogCache,
  readOpenCodeCatalogCache,
  saveCatalogCache,
  saveOpenCodeCatalogCache,
  setOpenCodeModelEnabled,
  setOpenRouterModelEnabled,
} from "./chat-model-catalog-repository";

const TTL_MS = 15 * 60 * 1000;
const OPENCODE_PROVIDERS = [{ id: "opencode", name: "OpenCode" }];
export class ChatModelAuthorizationError extends Error {}

type CatalogSource = { models: ChatModelInfo[]; providers: Array<{ id: string; name: string }>; fetchedAt: string };
type RefreshResult = { source: CatalogSource | null; stale: boolean; providerError: string | null };

async function refreshSource(
  fresh: boolean,
  cached: CatalogSource | null,
  fetchSource: () => Promise<CatalogSource>,
  save: (source: CatalogSource) => Promise<void>,
): Promise<RefreshResult> {
  if (fresh) return { source: cached, stale: false, providerError: null };
  try {
    const next = await fetchSource();
    await save(next).catch(() => undefined);
    return { source: next, stale: false, providerError: null };
  } catch (error) {
    const providerError = error instanceof Error ? error.message : "The model catalog is unavailable.";
    if (!cached) throw error;
    return { source: cached, stale: true, providerError };
  }
}

export async function discoverChatModels(ownerId: string, params: URLSearchParams) {
  const query = parseCatalogQuery(params);
  const hash = catalogQueryHash(query);
  const canonical = canonicalCatalogQuery(query);
  const [cached, cachedOpenCode] = await Promise.all([readCatalogCache(hash), readOpenCodeCatalogCache(hash)]);
  const openRouterFresh = Boolean(cached) && Date.now() - Date.parse(cached!.fetchedAt) < TTL_MS;
  const openCodeFresh = Boolean(cachedOpenCode) && Date.now() - Date.parse(cachedOpenCode!.fetchedAt) < TTL_MS;
  const [openRouterResult, openCodeResult] = await Promise.all([
    refreshSource(openRouterFresh, cached,
      () => Promise.all([fetchOpenRouterModels(query.upstream), fetchOpenRouterProviders()])
        .then(([models, providers]) => ({ models, providers, fetchedAt: new Date().toISOString() })),
      (source) => saveCatalogCache(hash, canonical, source)),
    refreshSource(openCodeFresh, cachedOpenCode,
      () => fetchOpenCodeModels(query.upstream)
        .then((models) => ({ models, providers: OPENCODE_PROVIDERS, fetchedAt: new Date().toISOString() })),
      (source) => saveOpenCodeCatalogCache(hash, canonical, source)),
  ]);
  const source = openRouterResult.source;
  const openCodeSource = openCodeResult.source;
  if (!source && !openCodeSource) throw new OpenRouterError("OpenRouter catalog is unavailable.", 503);
  const [enabledOpenRouter, enabledOpenCode] = await Promise.all([listEnabledOpenRouterModels(ownerId), listEnabledOpenCodeModels(ownerId)]);
  const enabled = new Set([...enabledOpenRouter, ...enabledOpenCode]);
  const allModels = [...(source?.models ?? []), ...(openCodeSource?.models ?? [])];
  const models = query.enabled === "enabled" ? allModels.filter((model) => enabled.has(model.ref.model)) : allModels;
  const authors = [...new Set(models.map((item) => item.author).filter((item): item is string => Boolean(item)))].sort();
  const architectures = [...new Set(models.map((item) => item.architecture).filter((item): item is string => Boolean(item)))].sort();
  const fetchedAt = [source?.fetchedAt, openCodeSource?.fetchedAt].filter((item): item is string => Boolean(item)).sort().at(-1) ?? new Date().toISOString();
  return {
    models: models.map((model) => ({ ...model, enabled: enabled.has(model.ref.model) })),
    total: models.length, appliedFilters: query.applied,
    facets: { authors, architectures, providers: [...(source?.providers ?? []), ...(openCodeSource?.providers ?? [])] },
    cache: { fetchedAt, stale: openRouterResult.stale || openCodeResult.stale, ttlSeconds: TTL_MS / 1000 },
    providerError: openRouterResult.providerError ?? openCodeResult.providerError,
  };
}
export async function composerChatModels(ownerId: string): Promise<ChatModelInfo[]> {
  const [enabledOpenRouter, enabledOpenCode] = await Promise.all([listEnabledOpenRouterModels(ownerId), listEnabledOpenCodeModels(ownerId)]);
  if (!enabledOpenRouter.length && !enabledOpenCode.length) return DEFAULT_CHAT_MODELS;
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
  if (ref.provider === "opencode") {
    const catalog = await discoverChatModels(ownerId, new URLSearchParams({ q: ref.model }));
    if (!catalog.models.some((item) => item.ref.provider === "opencode" && item.ref.model === ref.model)) throw new ChatModelAuthorizationError("Model is not eligible.");
    await setOpenCodeModelEnabled(ownerId, ref.model, enabled);
    return;
  }
  if (ref.provider !== "openrouter") throw new ChatModelAuthorizationError("Built-in models cannot be disabled.");
  const catalog = await discoverChatModels(ownerId, new URLSearchParams({ q: ref.model }));
  if (!catalog.models.some((item) => item.ref.provider === "openrouter" && item.ref.model === ref.model)) throw new ChatModelAuthorizationError("Model is not eligible.");
  await setOpenRouterModelEnabled(ownerId, ref.model, enabled);
}
export async function authorizeChatModel(ownerId: string, ref: ChatModelRef): Promise<ChatModelInfo> {
  const builtIn = DEFAULT_CHAT_MODELS.find((item) => chatModelIdentity(item.ref) === chatModelIdentity(ref));
  if (builtIn) return builtIn;
  if (deterministicProviderEnabled()) return deterministicChatModelInfo(ref);
  if (ref.provider === "opencode") {
    const enabled = new Set(await listEnabledOpenCodeModels(ownerId));
    if (!enabled.has(ref.model)) throw new ChatModelAuthorizationError("Model is not enabled.");
    const catalog = await discoverChatModels(ownerId, new URLSearchParams({ q: ref.model }));
    const model = catalog.models.find((item) => item.ref.provider === "opencode" && item.ref.model === ref.model);
    if (!model) throw new ChatModelAuthorizationError("Model is no longer eligible.");
    return model;
  }
  if (ref.provider !== "openrouter") throw new ChatModelAuthorizationError("Model is not supported.");
  const enabled = new Set(await listEnabledOpenRouterModels(ownerId));
  if (!enabled.has(ref.model)) throw new ChatModelAuthorizationError("Model is not enabled.");
  const catalog = await discoverChatModels(ownerId, new URLSearchParams({ q: ref.model }));
  const model = catalog.models.find((item) => item.ref.provider === "openrouter" && item.ref.model === ref.model);
  if (!model) throw new ChatModelAuthorizationError("Model is no longer eligible.");
  return model;
}

export async function authorizeAutomationModel(ownerId: string, ref: ChatModelRef): Promise<ChatModelInfo> {
  if (deterministicProviderEnabled()) return deterministicChatModelInfo(ref);
  if (ref.provider !== "openrouter" || ref.model !== "qwen/qwen3.7-flash") return authorizeChatModel(ownerId, ref);
  const catalog = await discoverChatModels(ownerId, new URLSearchParams({ q: ref.model }));
  const model = catalog.models.find((item) => item.ref.model === ref.model && item.toolSupport && item.outputModalities.includes("text"));
  if (!model) throw new ChatModelAuthorizationError("The default automation model is unavailable.");
  return model;
}
