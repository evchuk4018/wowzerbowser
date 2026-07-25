import type { UsagePricing } from "../../../lib/usage-protocol";

/** Provider-owned fallback values; deployment catalog rows remain authoritative. */
export const DEFAULT_DEEPSEEK_USAGE_PRICING: UsagePricing[] = [
  {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    inputUsdPerMillion: 0.14,
    cachedInputUsdPerMillion: 0.0028,
    outputUsdPerMillion: 0.28,
  },
  {
    provider: "deepseek",
    model: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    inputUsdPerMillion: 0.435,
    cachedInputUsdPerMillion: 0.003625,
    outputUsdPerMillion: 0.87,
  },
];
