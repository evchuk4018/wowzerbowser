import "server-only";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_FREE_MODEL = "openrouter/free";
export const OPENROUTER_QUOTA_FALLBACK_MODEL = "qwen/qwen3.7-flash";

export const OPENROUTER_IMAGE_MODELS = [
  OPENROUTER_FREE_MODEL,
  OPENROUTER_QUOTA_FALLBACK_MODEL,
] as const;

export function shouldUseOpenRouterQuotaFallback(status: number, model: string): boolean {
  return model === OPENROUTER_FREE_MODEL && status === 429;
}
