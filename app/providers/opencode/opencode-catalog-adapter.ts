import "server-only";

import type { ChatModelInfo, ChatModelPricing } from "../../../lib/chat-protocol";
import { OPENCODE_BASE_URL, openCodeApiKey, openCodeHeaders } from "./opencode-config";

export class OpenCodeError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
    this.name = "OpenCodeError";
  }
}

const FREE_PRICING: ChatModelPricing = {
  inputUsdPerMillion: 0,
  cachedInputUsdPerMillion: 0,
  outputUsdPerMillion: 0,
  requestUsd: null,
  reasoningUsdPerMillion: 0,
};

type OpenCodeModelSnapshot = Omit<ChatModelInfo, "ref"> & { id: string };

/**
 * The OpenCode Zen /models endpoint exposes only ids, so the curated free-tier
 * set below carries the metadata (context, modalities, pricing) locally. All
 * entries speak the OpenAI-compatible chat completions endpoint that the chat
 * pipeline uses; vision and reasoning-capable models on Zen's other endpoint
 * families are deliberately excluded.
 */
export const OPENCODE_MODEL_SNAPSHOT: OpenCodeModelSnapshot[] = [
  {
    id: "deepseek-v4-flash-free",
    displayName: "DeepSeek V4 Flash Free",
    description: "Free limited-time DeepSeek V4 Flash served through OpenCode Zen.",
    author: "DeepSeek",
    architecture: "DeepSeek V4",
    inputModalities: ["text"],
    outputModalities: ["text"],
    toolSupport: true,
    supportedParameters: ["tools"],
    reasoningRequired: false,
    supportedEfforts: [],
    defaultReasoningEffort: null,
    contextLength: 1_000_000,
    createdAt: null,
    pricing: FREE_PRICING,
  },
  {
    id: "big-pickle",
    displayName: "Big Pickle",
    description: "Stealth model that is free on OpenCode Zen for a limited time.",
    author: "Big Pickle",
    architecture: "Big Pickle",
    inputModalities: ["text"],
    outputModalities: ["text"],
    toolSupport: true,
    supportedParameters: ["tools"],
    reasoningRequired: false,
    supportedEfforts: [],
    defaultReasoningEffort: null,
    contextLength: 128_000,
    createdAt: null,
    pricing: FREE_PRICING,
  },
  {
    id: "mimo-v2.5-free",
    displayName: "MiMo-V2.5 Free",
    description: "Free limited-time Xiaomi MiMo V2.5 served through OpenCode Zen.",
    author: "Xiaomi",
    architecture: "MiMo V2.5",
    inputModalities: ["text"],
    outputModalities: ["text"],
    toolSupport: true,
    supportedParameters: ["tools"],
    reasoningRequired: false,
    supportedEfforts: [],
    defaultReasoningEffort: null,
    contextLength: 128_000,
    createdAt: null,
    pricing: FREE_PRICING,
  },
  {
    id: "hy3-free",
    displayName: "Hy3 Free",
    description: "Free limited-time Hy3 served through OpenCode Zen.",
    author: "H",
    architecture: "Hy3",
    inputModalities: ["text"],
    outputModalities: ["text"],
    toolSupport: true,
    supportedParameters: ["tools"],
    reasoningRequired: false,
    supportedEfforts: [],
    defaultReasoningEffort: null,
    contextLength: 128_000,
    createdAt: null,
    pricing: FREE_PRICING,
  },
  {
    id: "laguna-s-2.1-free",
    displayName: "Laguna S 2.1 Free",
    description: "Free limited-time Laguna S 2.1 served through OpenCode Zen.",
    author: "Laguna",
    architecture: "Laguna S 2.1",
    inputModalities: ["text"],
    outputModalities: ["text"],
    toolSupport: true,
    supportedParameters: ["tools"],
    reasoningRequired: false,
    supportedEfforts: [],
    defaultReasoningEffort: null,
    contextLength: 128_000,
    createdAt: null,
    pricing: FREE_PRICING,
  },
  {
    id: "nemotron-3-ultra-free",
    displayName: "Nemotron 3 Ultra Free",
    description: "Free limited-time NVIDIA Nemotron 3 Ultra trial endpoint.",
    author: "NVIDIA",
    architecture: "Nemotron 3 Ultra",
    inputModalities: ["text"],
    outputModalities: ["text"],
    toolSupport: true,
    supportedParameters: ["tools"],
    reasoningRequired: false,
    supportedEfforts: [],
    defaultReasoningEffort: null,
    contextLength: 256_000,
    createdAt: null,
    pricing: FREE_PRICING,
  },
  {
    id: "nemotron-3.5-lightning-free",
    displayName: "Nemotron 3.5 Lightning Free",
    description: "Free limited-time NVIDIA Nemotron 3.5 Lightning trial endpoint.",
    author: "NVIDIA",
    architecture: "Nemotron 3.5 Lightning",
    inputModalities: ["text"],
    outputModalities: ["text"],
    toolSupport: true,
    supportedParameters: ["tools"],
    reasoningRequired: false,
    supportedEfforts: [],
    defaultReasoningEffort: null,
    contextLength: 256_000,
    createdAt: null,
    pricing: FREE_PRICING,
  },
];

export function normalizeOpenCodeModel(id: string): ChatModelInfo | null {
  const snapshot = OPENCODE_MODEL_SNAPSHOT.find((item) => item.id === id);
  if (!snapshot) return null;
  const { id: model, ...metadata } = snapshot;
  return { ref: { provider: "opencode", model }, ...metadata };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) {
    const message = await response.text().catch(() => "");
    throw new OpenCodeError(message.slice(0, 240) || `OpenCode request failed (${response.status}).`, response.status >= 500 ? 502 : response.status);
  }
  try {
    return await response.json() as Record<string, unknown>;
  } catch {
    throw new OpenCodeError("OpenCode returned malformed JSON.");
  }
}

function tokens(value: string | undefined): string[] {
  return value ? value.split(",").map((item) => item.trim()).filter(Boolean) : [];
}

function matchesTokens(model: ChatModelInfo, field: string, values: readonly string[]): boolean {
  if (!values.length) return true;
  if (field === "providers") return values.includes("opencode");
  const list = field === "input_modalities" ? model.inputModalities
    : field === "output_modalities" ? model.outputModalities
    : model.supportedParameters;
  return values.every((value) => list.includes(value));
}

/**
 * OpenCode Zen has no upstream catalog query support, so the requested
 * filters are applied locally to the curated snapshot. Baseline eligibility
 * (text output, tools) is enforced by the snapshot itself.
 */
export function applyOpenCodeQuery(models: ChatModelInfo[], upstream: URLSearchParams): ChatModelInfo[] {
  const q = upstream.get("q")?.trim().toLowerCase();
  const minPrice = Number(upstream.get("min_price"));
  const maxPrice = upstream.has("max_price") ? Number(upstream.get("max_price")) : null;
  const minContext = Number(upstream.get("context"));
  const category = upstream.get("category")?.trim().toLowerCase();
  const arch = upstream.get("arch")?.trim().toLowerCase();
  const authors = tokens(upstream.get("model_authors") ?? undefined).map((value) => value.toLowerCase());
  const providers = tokens(upstream.get("providers") ?? undefined);
  const listFilters = [
    ["input_modalities", tokens(upstream.get("input_modalities") ?? undefined)] as const,
    ["output_modalities", tokens(upstream.get("output_modalities") ?? undefined)] as const,
    ["supported_parameters", tokens(upstream.get("supported_parameters") ?? undefined)] as const,
    ["providers", providers] as const,
  ];
  return models.filter((model) => {
    if (q && !`${model.displayName} ${model.ref.model} ${model.author ?? ""}`.toLowerCase().includes(q)) return false;
    if (category && !`${model.displayName} ${model.description ?? ""}`.toLowerCase().includes(category)) return false;
    if (arch && !(model.architecture ?? "").toLowerCase().includes(arch)) return false;
    if (authors.length && !authors.some((author) => (model.author ?? "").toLowerCase().includes(author))) return false;
    if (minContext && model.contextLength < minContext) return false;
    const input = model.pricing?.inputUsdPerMillion ?? null;
    if (Number.isFinite(minPrice) && minPrice > 0 && (input === null || input < minPrice)) return false;
    if (maxPrice !== null && Number.isFinite(maxPrice) && input !== null && input > maxPrice) return false;
    return listFilters.every(([field, values]) => matchesTokens(model, field, values));
  });
}

export async function fetchOpenCodeModels(upstream: URLSearchParams = new URLSearchParams(), fetchImpl: typeof fetch = fetch): Promise<ChatModelInfo[]> {
  if (!openCodeApiKey()) return [];
  const payload = await readJson(await fetchImpl(`${OPENCODE_BASE_URL}/models`, { headers: openCodeHeaders() }));
  const data = Array.isArray(payload.data) ? payload.data : [];
  const available = new Set(
    data.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const id = (item as Record<string, unknown>).id;
      return typeof id === "string" ? [id] : [];
    }),
  );
  return applyOpenCodeQuery(
    OPENCODE_MODEL_SNAPSHOT
      .map((item) => item.id)
      .filter((id) => available.has(id))
      .map((id) => normalizeOpenCodeModel(id))
      .filter((item): item is ChatModelInfo => item !== null),
    upstream,
  );
}
