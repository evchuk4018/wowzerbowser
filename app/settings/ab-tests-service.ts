import { authFetch } from "../auth/auth-fetch";
import type {
  AbTestOverviewPayload,
  AbTestRequestScopedSnapshot,
  AbTestTrialCreateRequest,
  AbTestTrialPayload,
} from "../../lib/ab-test-protocol";

/**
 * The settings UI uses the shared protocol for requests and trial results.
 * Mutation responses are intentionally mapped here because the API wraps a
 * created/stopped trial while GET returns the overview directly.
 */
export type AbTestState = AbTestOverviewPayload;
export type AbTestVariantSnapshot = AbTestRequestScopedSnapshot;
export type AbTestTrial = AbTestTrialPayload;
export type CreateAbTestInput = AbTestTrialCreateRequest;

async function readResponse<T>(response: Response, fallback: string): Promise<T> {
  const body = await response.json().catch(() => null) as { error?: unknown } | T | null;
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body && typeof body.error === "string"
      ? body.error
      : fallback;
    throw new Error(message);
  }
  return body as T;
}

export async function fetchAbTestState(): Promise<AbTestState> {
  return readResponse<AbTestState>(
    await authFetch("/api/ab-tests", { cache: "no-store" }),
    "A/B testing results could not be loaded.",
  );
}

export async function createAbTest(input: CreateAbTestInput): Promise<AbTestTrial> {
  const body = await readResponse<{ trial?: AbTestTrial }>(
    await authFetch("/api/ab-tests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
    "The A/B trial could not be started.",
  );
  if (!body.trial) throw new Error("The A/B trial response was incomplete.");
  return body.trial;
}

export async function stopAbTest(trialId: string): Promise<AbTestTrial> {
  const body = await readResponse<{ trial?: AbTestTrial }>(
    await authFetch(`/api/ab-tests/${encodeURIComponent(trialId)}/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
    "The A/B trial could not be stopped.",
  );
  if (!body.trial) throw new Error("The stopped trial response was incomplete.");
  return body.trial;
}
