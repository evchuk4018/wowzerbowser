import { authFetch } from "../auth/auth-fetch";
import type { RuntimeConfigResponse, RuntimeConfigValues } from "../../lib/runtime-config-protocol";

export async function saveRuntimeConfig(values: Partial<RuntimeConfigValues>): Promise<RuntimeConfigResponse> {
  const response = await authFetch("/api/configurables", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ values }),
  });
  const body = await response.json().catch(() => null) as { error?: unknown } | RuntimeConfigResponse | null;
  if (!response.ok) throw new Error(body && "error" in body && typeof body.error === "string" ? body.error : "Runtime configuration could not be saved.");
  return body as RuntimeConfigResponse;
}
