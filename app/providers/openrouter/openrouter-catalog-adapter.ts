import "server-only";

import type { ChatModelInfo, ChatModelPricing, ChatReasoningEffort } from "../../../lib/chat-protocol";
import { OPENROUTER_API_KEY, OPENROUTER_BASE_URL, openRouterHeaders } from "./openrouter-config";

export class OpenRouterError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
    this.name = "OpenRouterError";
  }
}

type RawModel = Record<string, unknown>;
type RawProvider = Record<string, unknown>;

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function nullableNumber(value: unknown, multiplier = 1): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number * multiplier : null;
}

function pricing(value: unknown): ChatModelPricing | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const result = {
    inputUsdPerMillion: nullableNumber(raw.prompt, 1_000_000),
    cachedInputUsdPerMillion: nullableNumber(raw.input_cache_read ?? raw.input_cache_reads, 1_000_000),
    outputUsdPerMillion: nullableNumber(raw.completion, 1_000_000),
    requestUsd: nullableNumber(raw.request),
    reasoningUsdPerMillion: nullableNumber(raw.internal_reasoning, 1_000_000),
  };
  return Object.values(result).some((item) => item !== null) ? result : null;
}

function reasoningEfforts(model: RawModel, parameters: string[]): ChatReasoningEffort[] {
  const reasoning = model.reasoning && typeof model.reasoning === "object" ? model.reasoning as Record<string, unknown> : {};
  const advertised = strings(reasoning.supported_efforts ?? model.supported_reasoning_efforts);
  const allowed = new Set<ChatReasoningEffort>(["minimal", "low", "medium", "high", "xhigh", "max"]);
  const normalized = advertised.filter((item): item is ChatReasoningEffort => allowed.has(item as ChatReasoningEffort));
  return normalized.length ? normalized : parameters.includes("reasoning") ? ["low", "medium", "high"] : [];
}

export function normalizeOpenRouterModel(model: RawModel): ChatModelInfo | null {
  if (typeof model.id !== "string" || !model.id) return null;
  const architecture = model.architecture && typeof model.architecture === "object"
    ? model.architecture as Record<string, unknown>
    : {};
  const inputModalities = strings(architecture.input_modalities ?? model.input_modalities);
  const outputModalities = strings(architecture.output_modalities ?? model.output_modalities);
  const supportedParameters = strings(model.supported_parameters);
  // Eligibility is deliberately revalidated locally even though the upstream
  // request always locks these filters.
  if (!outputModalities.includes("text") || !supportedParameters.includes("tools")) return null;
  const efforts = reasoningEfforts(model, supportedParameters);
  const reasoning = model.reasoning && typeof model.reasoning === "object" ? model.reasoning as Record<string, unknown> : {};
  const required = Boolean(reasoning.mandatory === true || model.reasoning_required === true
    || (model.top_provider && typeof model.top_provider === "object"
      && (model.top_provider as Record<string, unknown>).is_moderated === "reasoning"));
  const advertisedDefault = reasoning.default_effort ?? model.default_reasoning_effort;
  const defaultEffort = typeof advertisedDefault === "string"
    && efforts.includes(advertisedDefault as ChatReasoningEffort)
    ? advertisedDefault as ChatReasoningEffort
    : efforts.includes("medium") ? "medium" : efforts[0] ?? null;
  const created = nullableNumber(model.created);
  const slugAuthor = model.id.split("/")[0] || null;
  return {
    ref: { provider: "openrouter", model: model.id },
    displayName: typeof model.name === "string" && model.name.trim() ? model.name : model.id,
    description: typeof model.description === "string" ? model.description : null,
    author: typeof model.author === "string" ? model.author : slugAuthor,
    architecture: typeof architecture.tokenizer === "string"
      ? architecture.tokenizer
      : typeof architecture.instruct_type === "string" ? architecture.instruct_type : null,
    inputModalities,
    outputModalities,
    toolSupport: true,
    supportedParameters,
    reasoningRequired: required,
    supportedEfforts: efforts,
    defaultReasoningEffort: defaultEffort,
    contextLength: nullableNumber(model.context_length) ?? 0,
    createdAt: created === null ? null : new Date(created * 1000).toISOString(),
    pricing: pricing(model.pricing),
  };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) {
    const message = await response.text().catch(() => "");
    throw new OpenRouterError(message.slice(0, 240) || `OpenRouter request failed (${response.status}).`, response.status >= 500 ? 502 : response.status);
  }
  try {
    return await response.json() as Record<string, unknown>;
  } catch {
    throw new OpenRouterError("OpenRouter returned malformed JSON.");
  }
}

export async function fetchOpenRouterModels(query: URLSearchParams, fetchImpl: typeof fetch = fetch): Promise<ChatModelInfo[]> {
  if (!OPENROUTER_API_KEY) throw new OpenRouterError("OpenRouter is not configured.", 503);
  const locked = new URLSearchParams(query);
  const outputs = new Set(locked.getAll("output_modalities").flatMap((item) => item.split(",")));
  outputs.add("text");
  locked.delete("output_modalities");
  locked.set("output_modalities", [...outputs].sort().join(","));
  const parameters = new Set(locked.getAll("supported_parameters").flatMap((item) => item.split(",")));
  parameters.add("tools");
  locked.delete("supported_parameters");
  locked.set("supported_parameters", [...parameters].sort().join(","));
  for (const field of ["input_modalities", "arch", "model_authors", "providers"]) {
    const values = locked.getAll(field).flatMap((item) => item.split(",")).filter(Boolean);
    if (values.length) {
      locked.delete(field);
      locked.set(field, [...new Set(values)].sort().join(","));
    }
  }
  const payload = await readJson(await fetchImpl(`${OPENROUTER_BASE_URL}/models?${locked}`, { headers: openRouterHeaders() }));
  const data = Array.isArray(payload.data) ? payload.data : [];
  return data.map((item) => item && typeof item === "object" ? normalizeOpenRouterModel(item as RawModel) : null)
    .filter((item): item is ChatModelInfo => item !== null);
}

export type OpenRouterProvider = { id: string; name: string };

export async function fetchOpenRouterProviders(fetchImpl: typeof fetch = fetch): Promise<OpenRouterProvider[]> {
  if (!OPENROUTER_API_KEY) throw new OpenRouterError("OpenRouter is not configured.", 503);
  const payload = await readJson(await fetchImpl(`${OPENROUTER_BASE_URL}/providers`, { headers: openRouterHeaders() }));
  return (Array.isArray(payload.data) ? payload.data : []).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const provider = item as RawProvider;
    const id = typeof provider.slug === "string" ? provider.slug : typeof provider.id === "string" ? provider.id : null;
    if (!id) return [];
    return [{ id, name: typeof provider.name === "string" ? provider.name : id }];
  });
}
