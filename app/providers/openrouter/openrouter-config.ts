import "server-only";

export const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL?.trim() || "https://openrouter.ai/api/v1";
export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY?.trim() || "";
export const OPENROUTER_FREE_MODEL = "openrouter/free";
export const OPENROUTER_QWEN_FLASH_MODEL = "qwen/qwen3.7-flash";
export const OPENROUTER_AUTO_MODEL = "openrouter/auto";
export const OPENROUTER_NEX_N2_MINI_MODEL = "nex-agi/nex-n2-mini";
export const OPENROUTER_GEMINI_FLASH_LITE_MODEL = "google/gemini-2.5-flash-lite";
export const OPENROUTER_QUOTA_FALLBACK_MODEL = OPENROUTER_QWEN_FLASH_MODEL;
export const OPENROUTER_IMAGE_MODELS = [
  OPENROUTER_QWEN_FLASH_MODEL,
  OPENROUTER_AUTO_MODEL,
  OPENROUTER_NEX_N2_MINI_MODEL,
  OPENROUTER_GEMINI_FLASH_LITE_MODEL,
] as const;

export function openRouterApiKey(): string {
  return process.env.OPENROUTER_API_KEY?.trim() || OPENROUTER_API_KEY;
}

export function shouldUseOpenRouterQuotaFallback(status: number, model: string): boolean {
  return model === OPENROUTER_FREE_MODEL && status === 429;
}

export function openRouterHeaders(): HeadersInit {
  return {
    authorization: `Bearer ${openRouterApiKey()}`,
    "content-type": "application/json",
    ...(process.env.OPENROUTER_SITE_URL ? { "HTTP-Referer": process.env.OPENROUTER_SITE_URL } : {}),
    ...(process.env.OPENROUTER_APP_NAME ? { "X-Title": process.env.OPENROUTER_APP_NAME } : {}),
  };
}
