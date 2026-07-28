import "server-only";

export const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL?.trim() || "https://openrouter.ai/api/v1";
export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY?.trim() || "";
export const OPENROUTER_FREE_MODEL = "openrouter/free";
export const OPENROUTER_QUOTA_FALLBACK_MODEL = "qwen/qwen3.7-flash";
export const OPENROUTER_IMAGE_MODELS = [OPENROUTER_FREE_MODEL, OPENROUTER_QUOTA_FALLBACK_MODEL] as const;

export function shouldUseOpenRouterQuotaFallback(status: number, model: string): boolean {
  return model === OPENROUTER_FREE_MODEL && status === 429;
}

export function openRouterHeaders(): HeadersInit {
  return {
    authorization: `Bearer ${OPENROUTER_API_KEY}`,
    "content-type": "application/json",
    ...(process.env.OPENROUTER_SITE_URL ? { "HTTP-Referer": process.env.OPENROUTER_SITE_URL } : {}),
    ...(process.env.OPENROUTER_APP_NAME ? { "X-Title": process.env.OPENROUTER_APP_NAME } : {}),
  };
}
