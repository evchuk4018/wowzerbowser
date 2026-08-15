import type { UsagePricing } from "../../../lib/usage-protocol";

const free: Omit<UsagePricing, "provider" | "model" | "label"> = {
  inputUsdPerMillion: 0,
  cachedInputUsdPerMillion: 0,
  outputUsdPerMillion: 0,
  requestUsd: null,
  reasoningUsdPerMillion: 0,
};

/**
 * Provider-owned fallback values for the OpenCode Zen free tier; deployment
 * catalog rows remain authoritative. All curated models are free during their
 * limited-time trial windows.
 */
export const DEFAULT_OPENCODE_USAGE_PRICING: UsagePricing[] = [
  { provider: "opencode", model: "deepseek-v4-flash-free", label: "DeepSeek V4 Flash Free", ...free },
  { provider: "opencode", model: "mimo-v2.5-free", label: "MiMo-V2.5 Free", ...free },
  { provider: "opencode", model: "hy3-free", label: "Hy3 Free", ...free },
  { provider: "opencode", model: "laguna-s-2.1-free", label: "Laguna S 2.1 Free", ...free },
  { provider: "opencode", model: "nemotron-3-ultra-free", label: "Nemotron 3 Ultra Free", ...free },
  { provider: "opencode", model: "nemotron-3.5-lightning-free", label: "Nemotron 3.5 Lightning Free", ...free },
  { provider: "opencode", model: "big-pickle", label: "Big Pickle", ...free },
];
