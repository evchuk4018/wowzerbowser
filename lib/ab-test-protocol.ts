import {
  CHAT_REASONING_EFFORTS,
  isChatModelRef,
  type ChatModelRef,
  type ChatReasoningEffort,
} from "./chat-protocol";

export const AB_TEST_ASSIGNMENT_RATE = 0.1;
export const AB_TEST_VARIANT_KEYS = ["a", "b"] as const;
export const AB_TEST_DISPLAY_LABELS = ["a", "b"] as const;
export const AB_TEST_TRIAL_STATUSES = ["active", "stopped"] as const;
export const AB_TEST_COMPARISON_STATUSES = ["pending", "voted"] as const;
export const AB_TEST_MAX_SNAPSHOT_LENGTH = 64 * 1024;
export const AB_TEST_MAX_SYSTEM_PROMPT_LENGTH = 12_000;
export const AB_TEST_MAX_USER_PRESENCE_LENGTH = 12_000;
export const AB_TEST_IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const AB_TEST_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type AbTestVariantKey = (typeof AB_TEST_VARIANT_KEYS)[number];
export type AbTestDisplayLabel = (typeof AB_TEST_DISPLAY_LABELS)[number];
export type AbTestTrialStatus = (typeof AB_TEST_TRIAL_STATUSES)[number];
export type AbTestComparisonStatus = (typeof AB_TEST_COMPARISON_STATUSES)[number];

/** Settings that can be applied independently to a normal chat request. */
export type AbTestRequestScopedSnapshot = {
  model: ChatModelRef;
  thinking: boolean;
  reasoningEffort: ChatReasoningEffort;
  systemPrompt: string;
  userPresence: string;
  contextMode: "full" | "focused";
  mode: "normal" | "deep_research";
};

export type AbTestVariantSnapshot = AbTestRequestScopedSnapshot;

/** Server-owned lineage identifiers used when a sampled turn is submitted. */
export type AbTestVariantPersistence = {
  versionId: string;
  userMessageId: string;
  assistantMessageId: string;
  versionIndex: number;
};

/** Internal execution metadata persisted inside a durable chat request. */
export type AbTestExecution = {
  trialId: string;
  comparisonId: string;
  turnId: string;
  displayAVariant: AbTestVariantKey;
  primaryJobId: string;
  variantA: {
    snapshot: AbTestRequestScopedSnapshot;
    persistence: AbTestVariantPersistence;
  };
  variantB: {
    snapshot: AbTestRequestScopedSnapshot;
    persistence: AbTestVariantPersistence;
  };
};

/** Metadata sent with the initial stream frame so the client can render both choices. */
export type AbTestSubmission = {
  trialId: string;
  comparisonId: string;
  turnId: string;
  displayAVariant: AbTestVariantKey;
  variants: {
    a: AbTestVariantPersistence;
    b: AbTestVariantPersistence;
  };
};

export type AbTestResult = {
  totalComparisons: number;
  completedComparisons: number;
  pendingComparisons: number;
  optionAWins: number;
  optionBWins: number;
  optionASelectionRate: number | null;
  variantAWins: number;
  variantBWins: number;
  variantAWinRate: number | null;
  variantBWinRate: number | null;
};

export type AbTestAggregate = AbTestResult;

export type AbTestComparison = {
  id: string;
  createdAt: string;
  selected: AbTestDisplayLabel | null;
  optionA: "variantA" | "variantB";
};

export type AbTestTrial = {
  id: string;
  name: string;
  status: AbTestTrialStatus;
  samplingRate: number;
  variantA: AbTestVariantSnapshot;
  variantB: AbTestVariantSnapshot;
  aggregate: AbTestAggregate;
  history: AbTestComparison[];
  createdAt: string;
  stoppedAt: string | null;
};

export type AbTestTrialPayload = AbTestTrial;

export type AbTestTrialCreateRequest = {
  name?: string;
  variants: {
    a: AbTestVariantSnapshot;
    b: AbTestVariantSnapshot;
  };
};

export type AbTestComparisonPayload = {
  id: string;
  trialId: string;
  conversationId: string;
  turnId: string;
  status: AbTestComparisonStatus;
  optionA: "variantA" | "variantB";
  options: {
    a: { responseId: string | null };
    b: { responseId: string | null };
  };
  selected: AbTestDisplayLabel | null;
  createdAt: string;
  selectedAt: string | null;
};

export type AbTestComparisonCreateRequest = {
  trialId: string;
  conversationId: string;
  turnId: string;
  responseIds?: {
    a?: string | null;
    b?: string | null;
  };
};

export type AbTestVoteRequest = {
  selection: AbTestDisplayLabel;
};

export type AbTestOverviewPayload = {
  activeTrial: AbTestTrialPayload | null;
  trials: AbTestTrialPayload[];
};

export type AbTestState = AbTestOverviewPayload;

export class AbTestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AbTestValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKnownKeys(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new AbTestValidationError(`${field}.${key} is not supported.`);
  }
}

function readBoundedString(value: unknown, field: string, maximum: number, required = true): string {
  if (typeof value !== "string") throw new AbTestValidationError(`${field} must be a string.`);
  const result = value.trim();
  if (required && !result) throw new AbTestValidationError(`${field} must not be empty.`);
  if (result.length > maximum) throw new AbTestValidationError(`${field} is too long.`);
  return result;
}

function readResponseId(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const result = readBoundedString(value, field, 128);
  if (!AB_TEST_IDENTIFIER_PATTERN.test(result)) throw new AbTestValidationError(`${field} is invalid.`);
  return result;
}

function readIdentifier(value: unknown, field: string): string {
  const result = readBoundedString(value, field, 128);
  if (!AB_TEST_IDENTIFIER_PATTERN.test(result)) throw new AbTestValidationError(`${field} is invalid.`);
  return result;
}

export function isAbTestVariantKey(value: unknown): value is AbTestVariantKey {
  return AB_TEST_VARIANT_KEYS.includes(value as AbTestVariantKey);
}

export function isAbTestDisplayLabel(value: unknown): value is AbTestDisplayLabel {
  return AB_TEST_DISPLAY_LABELS.includes(value as AbTestDisplayLabel);
}

export function isAbTestTrialId(value: unknown): value is string {
  return typeof value === "string" && AB_TEST_UUID_PATTERN.test(value);
}

export function isAbTestComparisonId(value: unknown): value is string {
  return isAbTestTrialId(value);
}

export function parseAbTestSnapshot(value: unknown, field = "snapshot"): AbTestRequestScopedSnapshot {
  if (!isRecord(value)) throw new AbTestValidationError(`${field} must be an object.`);
  assertKnownKeys(value, ["model", "thinking", "reasoningEffort", "systemPrompt", "userPresence", "contextMode", "mode"], field);
  if (!isChatModelRef(value.model)) throw new AbTestValidationError(`${field}.model must be a valid provider/model reference.`);
  if (typeof value.thinking !== "boolean") throw new AbTestValidationError(`${field}.thinking must be true or false.`);
  if (!CHAT_REASONING_EFFORTS.includes(value.reasoningEffort as ChatReasoningEffort)) throw new AbTestValidationError(`${field}.reasoningEffort is invalid.`);
  const systemPrompt = readBoundedString(value.systemPrompt, `${field}.systemPrompt`, AB_TEST_MAX_SYSTEM_PROMPT_LENGTH);
  const userPresence = readBoundedString(value.userPresence, `${field}.userPresence`, AB_TEST_MAX_USER_PRESENCE_LENGTH, false);
  const contextMode = value.contextMode;
  if (contextMode !== "full" && contextMode !== "focused") throw new AbTestValidationError(`${field}.contextMode is invalid.`);
  const mode = value.mode;
  if (mode !== "normal" && mode !== "deep_research") throw new AbTestValidationError(`${field}.mode is invalid.`);
  const result = { model: value.model, thinking: value.thinking, reasoningEffort: value.reasoningEffort, systemPrompt, userPresence, contextMode, mode } as AbTestRequestScopedSnapshot;
  if (JSON.stringify(result).length > AB_TEST_MAX_SNAPSHOT_LENGTH) throw new AbTestValidationError(`${field} is too large.`);
  return result;
}

export function parseAbTestTrialCreateRequest(value: unknown): AbTestTrialCreateRequest {
  if (!isRecord(value) || !isRecord(value.variants)) throw new AbTestValidationError("variants must be an object.");
  assertKnownKeys(value, ["name", "variants"], "request");
  const name = value.name === undefined ? "" : readBoundedString(value.name, "name", 120, false);
  return {
    ...(name ? { name } : {}),
    variants: {
      a: parseAbTestSnapshot(value.variants.a, "variants.a"),
      b: parseAbTestSnapshot(value.variants.b, "variants.b"),
    },
  };
}

export function parseAbTestComparisonCreateRequest(value: unknown): AbTestComparisonCreateRequest {
  if (!isRecord(value)) throw new AbTestValidationError("comparison must be an object.");
  assertKnownKeys(value, ["trialId", "conversationId", "turnId", "responseIds"], "comparison");
  if (!isAbTestTrialId(value.trialId)) throw new AbTestValidationError("comparison.trialId is invalid.");
  const conversationId = readIdentifier(value.conversationId, "comparison.conversationId");
  const turnId = readIdentifier(value.turnId, "comparison.turnId");
  let responseIds: AbTestComparisonCreateRequest["responseIds"];
  if (value.responseIds !== undefined) {
    if (!isRecord(value.responseIds)) throw new AbTestValidationError("comparison.responseIds must be an object.");
    assertKnownKeys(value.responseIds, ["a", "b"], "comparison.responseIds");
    responseIds = { a: readResponseId(value.responseIds.a, "comparison.responseIds.a"), b: readResponseId(value.responseIds.b, "comparison.responseIds.b") };
  }
  return { trialId: value.trialId, conversationId, turnId, ...(responseIds === undefined ? {} : { responseIds }) };
}

export function parseAbTestVoteRequest(value: unknown): AbTestVoteRequest {
  if (!isRecord(value) || !isAbTestDisplayLabel(value.selection)) throw new AbTestValidationError("selection must be either a or b.");
  assertKnownKeys(value, ["selection"], "vote");
  return { selection: value.selection };
}
