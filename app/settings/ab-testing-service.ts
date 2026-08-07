import { authFetch } from "../auth/auth-fetch";
import type {
  AbExperiment,
  AbExperimentCatalog,
  AbExperimentMutation,
  AbExperimentStatus,
  AbOverridePatch,
} from "../../lib/ab-testing-protocol";

export type AbExperimentResponse = {
  experiments: AbExperiment[];
  catalog: AbExperimentCatalog;
};

async function readError(response: Response): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : `Request failed (${response.status}).`;
}

export async function fetchAbExperiments(): Promise<AbExperimentResponse> {
  const response = await authFetch("/api/experiments");
  if (!response.ok) throw new Error(await readError(response));
  return response.json() as Promise<AbExperimentResponse>;
}

export async function createAbExperiment(mutation: AbExperimentMutation): Promise<string> {
  const response = await authFetch("/api/experiments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(mutation),
  });
  if (!response.ok) throw new Error(await readError(response));
  const body = await response.json() as { id?: unknown };
  if (typeof body.id !== "string") throw new Error("The experiment response was invalid.");
  return body.id;
}

export async function updateAbExperimentStatus(experimentId: string, status: AbExperimentStatus): Promise<void> {
  const response = await authFetch(`/api/experiments/${encodeURIComponent(experimentId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status }),
  });
  if (!response.ok) throw new Error(await readError(response));
}

export async function deleteAbExperiment(experimentId: string): Promise<void> {
  const response = await authFetch(`/api/experiments/${encodeURIComponent(experimentId)}`, { method: "DELETE" });
  if (!response.ok) throw new Error(await readError(response));
}

export function clonePatch(value: AbOverridePatch): AbOverridePatch {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, Array.isArray(item) ? [...item] : item])) as AbOverridePatch;
}
