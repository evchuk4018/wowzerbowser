import "server-only";

import { DeepSeekError } from "./deepseek-error";

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

function apiKey(): string {
  const value = process.env.DEEPSEEK_API_KEY?.trim();
  if (!value) throw new DeepSeekError("DeepSeek is not configured.", 503);
  return value;
}

export function assertDeepSeekConfigured(): void {
  apiKey();
}

export function deepSeekHeaders(): HeadersInit {
  return { authorization: `Bearer ${apiKey()}`, "content-type": "application/json" };
}
