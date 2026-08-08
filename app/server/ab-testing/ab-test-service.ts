import "server-only";

import {
  AB_TEST_ASSIGNMENT_RATE,
  AB_TEST_DISPLAY_LABELS,
  AB_TEST_UUID_PATTERN,
  AbTestValidationError,
  isAbTestDisplayLabel,
  parseAbTestComparisonCreateRequest,
  parseAbTestSnapshot,
  parseAbTestTrialCreateRequest,
  parseAbTestVoteRequest,
  type AbTestComparisonPayload,
  type AbTestDisplayLabel,
  type AbTestOverviewPayload,
  type AbTestRequestScopedSnapshot,
  type AbTestResult,
  type AbTestTrialPayload,
  type AbTestVariantKey,
} from "../../../lib/ab-test-protocol";
import { ChatModelAuthorizationError, authorizeChatModel } from "../chat/chat-model-catalog-service";
import {
  getAbTestComparisonRow,
  getAbTestTrialRow,
  insertAbTestComparisonRow,
  insertAbTestTrialRows,
  listAbTestVariantRows,
  listAbTestTrialRows,
  stopAbTestTrialRow,
  voteForAbTestComparisonRow,
  type AbTestComparisonRecord,
  type AbTestTrialRecord,
} from "./ab-test-repository";
import { selectAbTestVersion } from "./ab-test-chat-repository";

export class AbTestNotFoundError extends Error {}
export class AbTestActiveTrialExistsError extends Error {}
export class AbTestTrialStoppedError extends Error {}
export class AbTestVoteConflictError extends Error {}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "23505");
}

function assertUuid(value: string, field: string): void {
  if (!AB_TEST_UUID_PATTERN.test(value)) throw new AbTestValidationError(`${field} is invalid.`);
}

function snapshotsEqual(left: AbTestRequestScopedSnapshot, right: AbTestRequestScopedSnapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function authorizeSnapshot(ownerId: string, snapshot: AbTestRequestScopedSnapshot, field: string): Promise<AbTestRequestScopedSnapshot> {
  if (snapshot.mode !== "normal") throw new AbTestValidationError(`${field}.mode must be normal for an A/B trial.`);
  const metadata = await authorizeChatModel(ownerId, snapshot.model);
  if (metadata.reasoningRequired && !snapshot.thinking) throw new AbTestValidationError(`${field}.thinking must be enabled for this model.`);
  if (snapshot.thinking && !metadata.supportedEfforts.includes(snapshot.reasoningEffort)) {
    throw new AbTestValidationError(`${field}.reasoningEffort is not supported by this model.`);
  }
  return snapshot;
}

function resultForTrial(trial: AbTestTrialRecord): AbTestResult {
  const completed = trial.completedComparisons;
  const rate = (value: number) => completed > 0 ? value / completed : null;
  return {
    totalComparisons: trial.totalComparisons,
    completedComparisons: completed,
    pendingComparisons: Math.max(0, trial.totalComparisons - completed),
    optionAWins: trial.optionAWins,
    optionBWins: trial.optionBWins,
    optionASelectionRate: rate(trial.optionAWins),
    variantAWins: trial.variantAWins,
    variantBWins: trial.variantBWins,
    variantAWinRate: rate(trial.variantAWins),
    variantBWinRate: rate(trial.variantBWins),
  };
}

function trialPayload(trial: AbTestTrialRecord): AbTestTrialPayload {
  const variantA = parseAbTestSnapshot(trial.variants.a, "stored variantA");
  const variantB = parseAbTestSnapshot(trial.variants.b, "stored variantB");
  return {
    id: trial.id,
    name: trial.name,
    status: trial.status,
    samplingRate: trial.samplingRate,
    variantA,
    variantB,
    aggregate: resultForTrial(trial),
    history: trial.history.map((comparison) => ({
      id: comparison.id,
      createdAt: comparison.createdAt,
      selected: comparison.selectedLabel,
      optionA: comparison.displayAVariant === "a" ? "variantA" : "variantB",
    })),
    createdAt: trial.createdAt,
    stoppedAt: trial.stoppedAt,
  };
}

function comparisonPayload(comparison: AbTestComparisonRecord): AbTestComparisonPayload {
  return {
    id: comparison.id,
    trialId: comparison.trialId,
    conversationId: comparison.conversationId,
    turnId: comparison.turnId,
    status: comparison.selectedLabel === null ? "pending" : "voted",
    optionA: comparison.displayAVariant === "a" ? "variantA" : "variantB",
    options: {
      a: { responseId: comparison.optionAResponseId },
      b: { responseId: comparison.optionBResponseId },
    },
    selected: comparison.selectedLabel,
    createdAt: comparison.createdAt,
    selectedAt: comparison.selectedAt,
  };
}

export function shouldAssignAbTestComparison(randomValue = Math.random(), samplingRate = AB_TEST_ASSIGNMENT_RATE): boolean {
  if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue >= 1) throw new RangeError("randomValue must be in the interval [0, 1).");
  if (!Number.isFinite(samplingRate) || samplingRate <= 0 || samplingRate > 1) throw new RangeError("samplingRate must be greater than 0 and at most 1.");
  return randomValue < samplingRate;
}

export function assignAnonymousAbTestLabels(randomValue = Math.random()): { displayAVariant: AbTestVariantKey; displayBVariant: AbTestVariantKey } {
  if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue >= 1) throw new RangeError("randomValue must be in the interval [0, 1).");
  return randomValue < 0.5 ? { displayAVariant: "a", displayBVariant: "b" } : { displayAVariant: "b", displayBVariant: "a" };
}

export async function listAbTests(ownerId: string): Promise<AbTestOverviewPayload> {
  const trials = (await listAbTestTrialRows(ownerId)).map(trialPayload);
  return {
    activeTrial: trials.find((trial) => trial.status === "active") ?? null,
    trials,
  };
}

export async function getAbTest(ownerId: string, trialId: string): Promise<AbTestTrialPayload | null> {
  assertUuid(trialId, "trialId");
  const trial = await getAbTestTrialRow(ownerId, trialId);
  return trial ? trialPayload(trial) : null;
}

export async function createAbTest(ownerId: string, input: unknown): Promise<AbTestTrialPayload> {
  const request = parseAbTestTrialCreateRequest(input);
  const [a, b] = await Promise.all([
    authorizeSnapshot(ownerId, request.variants.a, "variants.a"),
    authorizeSnapshot(ownerId, request.variants.b, "variants.b"),
  ]);
  if (snapshotsEqual(a, b)) throw new AbTestValidationError("variants.a and variants.b must differ.");
  try {
    const trialId = await insertAbTestTrialRows(ownerId, { name: request.name ?? "", variants: { a, b } }, AB_TEST_ASSIGNMENT_RATE);
    const trial = await getAbTestTrialRow(ownerId, trialId);
    if (!trial) throw new Error("The A/B trial was not persisted.");
    return trialPayload(trial);
  } catch (error) {
    if (isUniqueViolation(error)) throw new AbTestActiveTrialExistsError("Only one active A/B trial is allowed.");
    throw error;
  }
}

export async function stopAbTest(ownerId: string, trialId: string): Promise<AbTestTrialPayload> {
  assertUuid(trialId, "trialId");
  if (!await stopAbTestTrialRow(ownerId, trialId)) throw new AbTestNotFoundError("A/B trial not found.");
  const trial = await getAbTestTrialRow(ownerId, trialId);
  if (!trial) throw new AbTestNotFoundError("A/B trial not found.");
  return trialPayload(trial);
}

export async function createAbTestComparison(ownerId: string, input: unknown, randomValue?: number): Promise<AbTestComparisonPayload | null> {
  const request = parseAbTestComparisonCreateRequest(input);
  const trial = await getAbTestTrialRow(ownerId, request.trialId);
  if (!trial) throw new AbTestNotFoundError("A/B trial not found.");
  if (trial.status !== "active") throw new AbTestTrialStoppedError("The A/B trial is stopped.");
  const labels = assignAnonymousAbTestLabels(randomValue);
  const comparison = await insertAbTestComparisonRow({
    ownerId,
    trialId: request.trialId,
    conversationId: request.conversationId,
    turnId: request.turnId,
    displayAVariant: labels.displayAVariant,
    responseIds: { a: request.responseIds?.a ?? null, b: request.responseIds?.b ?? null },
  });
  if (!comparison) throw new AbTestTrialStoppedError("The A/B trial is stopped.");
  return comparisonPayload(comparison);
}

export async function voteOnAbTestComparison(ownerId: string, trialId: string, comparisonId: string, input: unknown): Promise<AbTestComparisonPayload> {
  assertUuid(trialId, "trialId");
  assertUuid(comparisonId, "comparisonId");
  const { selection } = parseAbTestVoteRequest(input);
  const result = await voteForAbTestComparisonRow(ownerId, trialId, comparisonId, selection);
  if (!result) throw new AbTestNotFoundError("A/B comparison not found.");
  if (result.conflict) throw new AbTestVoteConflictError("This comparison has already been answered.");
  const selectedResponseId = selection === "a"
    ? result.comparison.optionAResponseId
    : result.comparison.optionBResponseId;
  if (!selectedResponseId) throw new AbTestValidationError("The selected A/B response is unavailable.");
  await selectAbTestVersion({
    ownerId,
    conversationId: result.comparison.conversationId,
    turnId: result.comparison.turnId,
    responseId: selectedResponseId,
  });
  return comparisonPayload(result.comparison);
}

export async function readAbTestComparison(ownerId: string, trialId: string, comparisonId: string): Promise<AbTestComparisonPayload | null> {
  assertUuid(trialId, "trialId");
  assertUuid(comparisonId, "comparisonId");
  const comparison = await getAbTestComparisonRow(ownerId, trialId, comparisonId);
  return comparison ? comparisonPayload(comparison) : null;
}

/** Stable service names used by the worker/chat integration without exposing database rows. */
export const insertAbTestComparison = createAbTestComparison;
export const listAbTestTrialRecords = listAbTests;
export const getAbTestTrialRecord = getAbTest;
export const getAbTestTrial = getAbTest;

export async function getAbTestVariants(ownerId: string, trialId: string): Promise<{ a: AbTestRequestScopedSnapshot; b: AbTestRequestScopedSnapshot }> {
  assertUuid(trialId, "trialId");
  const rows = await listAbTestVariantRows(ownerId, trialId);
  const a = rows.find((row) => row.variant_key === "a");
  const b = rows.find((row) => row.variant_key === "b");
  if (!a || !b) throw new AbTestNotFoundError("A/B trial variants not found.");
  return {
    a: parseAbTestSnapshot(a.snapshot, "stored variants.a"),
    b: parseAbTestSnapshot(b.snapshot, "stored variants.b"),
  };
}

export function isAbTestSelection(value: unknown): value is AbTestDisplayLabel {
  return isAbTestDisplayLabel(value) && AB_TEST_DISPLAY_LABELS.includes(value);
}

export { ChatModelAuthorizationError };
