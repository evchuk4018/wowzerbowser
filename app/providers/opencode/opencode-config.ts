import "server-only";

export const OPENCODE_BASE_URL = process.env.OPENCODE_BASE_URL?.trim() || "https://opencode.ai/zen/v1";

export function openCodeApiKey(): string {
  return process.env.OPENCODE_API_KEY?.trim() || "";
}

export function openCodeConfigured(): boolean {
  return Boolean(openCodeApiKey());
}

export function openCodeHeaders(): HeadersInit {
  return {
    authorization: `Bearer ${openCodeApiKey()}`,
    "content-type": "application/json",
  };
}
