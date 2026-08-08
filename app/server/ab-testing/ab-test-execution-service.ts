import "server-only";

import type { ChatRequest } from "../../../lib/chat-protocol";
import {
  AB_TEST_ASSIGNMENT_RATE,
  parseAbTestSnapshot,
  type AbTestExecution,
  type AbTestSubmission,
  type AbTestVariantPersistence,
  type AbTestRequestScopedSnapshot,
} from "../../../lib/ab-test-protocol";
import {
  assignAnonymousAbTestLabels,
  shouldAssignAbTestComparison,
} from "./ab-test-service";
import {
  findAbTestComparisonForTurn,
} from "./ab-test-chat-repository";
import {
  insertAbTestComparisonRow,
  listAbTestTrialRows as listTrials,
} from "./ab-test-repository";
import { chatProviderAdapter } from "../chat/chat-provider-registry";

function derivedId(value: string, suffix: string): string {
  const marker = `-ab-${suffix}`;
  return `${value.slice(0, Math.max(1, 128 - marker.length))}${marker}`;
}

function persistenceForRequest(request: ChatRequest): AbTestVariantPersistence | null {
  const value = request.persistence;
  if (!value) return null;
  return {
    versionId: value.versionId,
    userMessageId: value.userMessageId,
    assistantMessageId: value.assistantMessageId,
    versionIndex: value.versionIndex,
  };
}

function variantBPersistence(request: ChatRequest): AbTestVariantPersistence | null {
  const value = persistenceForRequest(request);
  if (!value) return null;
  return {
    versionId: derivedId(value.versionId, "version-b"),
    userMessageId: derivedId(value.userMessageId, "user-b"),
    assistantMessageId: derivedId(value.assistantMessageId, "assistant-b"),
    versionIndex: value.versionIndex + 1,
  };
}

function activeTrial(trials: Awaited<ReturnType<typeof listTrials>>) {
  return trials.find((trial) => trial.status === "active") ?? null;
}

function snapshot(value: unknown, field: string): AbTestRequestScopedSnapshot {
  return parseAbTestSnapshot(value, field);
}

/**
 * Decide and reserve a sampled comparison before the durable chat job is
 * submitted. The reservation makes random assignment idempotent across
 * transport retries while the job's idempotency key remains authoritative.
 */
export async function prepareAbTestExecution(
  ownerId: string,
  request: ChatRequest,
  randomValue = Math.random(),
): Promise<AbTestExecution | null> {
  if (!request.conversationId || !request.jobId || !request.persistence) return null;
  if (request.mode === "deep_research") return null;
  const trial = activeTrial(await listTrials(ownerId));
  if (!trial) return null;
  const a = snapshot(trial.variants.a, "stored variants.a");
  const b = snapshot(trial.variants.b, "stored variants.b");
  if (a.mode !== "normal" || b.mode !== "normal") return null;
  chatProviderAdapter(a.model.provider).assertConfigured();
  chatProviderAdapter(b.model.provider).assertConfigured();
  const primary = persistenceForRequest(request);
  const secondary = variantBPersistence(request);
  if (!primary || !secondary) return null;

  const existing = await findAbTestComparisonForTurn(ownerId, trial.id, request.conversationId, request.persistence.turnId);
  if (existing?.selected_label) return null;
  if (!existing && !shouldAssignAbTestComparison(randomValue, trial.samplingRate || AB_TEST_ASSIGNMENT_RATE)) return null;
  const displayAVariant = existing?.display_a_variant ?? assignAnonymousAbTestLabels().displayAVariant;
  const aResponseId = primary.assistantMessageId;
  const bResponseId = secondary.assistantMessageId;
  const comparison = existing ?? await insertAbTestComparisonRow({
      ownerId,
      trialId: trial.id,
      conversationId: request.conversationId,
      turnId: request.persistence.turnId,
      displayAVariant,
      responseIds: { a: aResponseId, b: bResponseId },
    });
  if (!comparison) return null;
  const comparisonId = "id" in comparison ? comparison.id : comparison.comparison_id;
  const comparisonDisplayAVariant = "displayAVariant" in comparison
    ? comparison.displayAVariant
    : comparison.display_a_variant;

  return {
    trialId: trial.id,
    comparisonId,
    turnId: request.persistence.turnId,
    displayAVariant: comparisonDisplayAVariant,
    primaryJobId: request.jobId,
    variantA: { snapshot: a, persistence: primary },
    variantB: { snapshot: b, persistence: secondary },
  };
}

export function abTestSubmissionForRequest(request: ChatRequest): AbTestSubmission | undefined {
  const execution = request.abTest;
  if (!execution) return undefined;
  return {
    trialId: execution.trialId,
    comparisonId: execution.comparisonId,
    turnId: execution.turnId,
    displayAVariant: execution.displayAVariant,
    variants: {
      a: execution.variantA.persistence,
      b: execution.variantB.persistence,
    },
  };
}
