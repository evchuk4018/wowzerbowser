import "server-only";

import {
  AB_CHAT_SETTING_DEFINITIONS,
  isAbSettingKey,
  type AbExperiment,
  type AbExperimentAssignment,
  type AbExperimentCatalog,
  type AbExperimentMutation,
  type AbOverridePatch,
  type AbSettingKey,
  type AbSettingValue,
} from "../../../lib/ab-testing-protocol";
import {
  CHAT_REASONING_EFFORTS,
  isChatModelRef,
  type ChatRequest,
  type ChatReasoningEffort,
} from "../../../lib/chat-protocol";
import {
  isRuntimeConfigKey,
  type RuntimeConfigKey,
} from "../../../lib/runtime-config-protocol";
import {
  normalizeRuntimeConfigValue,
  runtimeConfigResponse,
  runtimeConfigSnapshot,
  RuntimeConfigValidationError,
} from "../config/runtime-config-service";
import {
  assignAbExperiment,
  createAbExperiment,
  deleteAbExperiment,
  listAbExperiments,
  mapAbExperimentRows,
  markAbVersionPreferred,
  setAbExperimentStatus,
} from "./ab-testing-repository";

const MAX_EXPERIMENT_NAME_LENGTH = 120;
const MAX_SYSTEM_PROMPT_LENGTH = 50_000;

export class AbExperimentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AbExperimentValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runtimeKeyFor(key: string): RuntimeConfigKey | null {
  if (!key.startsWith("runtime.")) return null;
  const runtimeKey = key.slice("runtime.".length);
  return isRuntimeConfigKey(runtimeKey) ? runtimeKey : null;
}

function normalizeChatValue(key: string, value: unknown): AbSettingValue {
  switch (key) {
    case "chat.model":
      if (!isChatModelRef(value)) throw new AbExperimentValidationError("Chat model must identify a supported provider and model.");
      return value;
    case "chat.thinking":
      if (typeof value !== "boolean") throw new AbExperimentValidationError("Reasoning enabled must be true or false.");
      return value;
    case "chat.reasoningEffort":
      if (!CHAT_REASONING_EFFORTS.includes(value as ChatReasoningEffort)) throw new AbExperimentValidationError("Reasoning effort is invalid.");
      return value as ChatReasoningEffort;
    case "chat.systemPrompt":
      if (typeof value !== "string" || !value.trim()) throw new AbExperimentValidationError("System prompt must not be empty.");
      if (value.length > MAX_SYSTEM_PROMPT_LENGTH) throw new AbExperimentValidationError(`System prompt must be ${MAX_SYSTEM_PROMPT_LENGTH} characters or shorter.`);
      return value;
    default:
      throw new AbExperimentValidationError(`Unknown A/B setting: ${key}.`);
  }
}

export function normalizeAbOverridePatch(value: unknown): AbOverridePatch {
  if (!isRecord(value)) throw new AbExperimentValidationError("A/B configuration must be an object.");
  const patch: AbOverridePatch = {};
  const entries = Object.entries(value);
  if (!entries.length) throw new AbExperimentValidationError("Each A/B variant must test at least one setting.");
  if (entries.length > 20) throw new AbExperimentValidationError("An A/B variant may test at most 20 settings.");
  for (const [key, candidate] of entries) {
    if (!isAbSettingKey(key)) throw new AbExperimentValidationError(`Unknown A/B setting: ${key}.`);
    const runtimeKey = runtimeKeyFor(key);
    if (runtimeKey) {
      try {
        patch[key as AbSettingKey] = normalizeRuntimeConfigValue(runtimeKey, candidate) as AbSettingValue;
      } catch (error) {
        if (error instanceof RuntimeConfigValidationError) throw new AbExperimentValidationError(error.message);
        throw error;
      }
    } else {
      patch[key as AbSettingKey] = normalizeChatValue(key, candidate);
    }
  }
  return patch;
}

export function normalizeAbExperimentMutation(value: unknown): AbExperimentMutation {
  if (!isRecord(value) || typeof value.name !== "string" || !value.name.trim()) {
    throw new AbExperimentValidationError("Experiment name is required.");
  }
  const name = value.name.trim();
  if (name.length > MAX_EXPERIMENT_NAME_LENGTH) throw new AbExperimentValidationError(`Experiment name must be ${MAX_EXPERIMENT_NAME_LENGTH} characters or shorter.`);
  const variantA = normalizeAbOverridePatch(value.variantA);
  const variantB = normalizeAbOverridePatch(value.variantB);
  const keysA = Object.keys(variantA).sort();
  const keysB = Object.keys(variantB).sort();
  if (keysA.join("\u0000") !== keysB.join("\u0000")) throw new AbExperimentValidationError("A and B must test the same settings.");
  if (keysA.every((key) => JSON.stringify(variantA[key as AbSettingKey]) === JSON.stringify(variantB[key as AbSettingKey]))) {
    throw new AbExperimentValidationError("A and B must differ in at least one setting.");
  }
  return { name, variantA, variantB };
}

export function runtimeOverridesForAssignment(assignment: AbExperimentAssignment): Partial<Record<RuntimeConfigKey, unknown>> {
  const result: Partial<Record<RuntimeConfigKey, unknown>> = {};
  for (const [key, value] of Object.entries(assignment.overrides)) {
    const runtimeKey = runtimeKeyFor(key);
    if (runtimeKey) result[runtimeKey] = value;
  }
  return result;
}

export function applyAbAssignmentToChatRequest(request: ChatRequest, assignment: AbExperimentAssignment): ChatRequest {
  let next = { ...request };
  for (const [key, value] of Object.entries(assignment.overrides)) {
    switch (key) {
      case "chat.model":
        next = { ...next, model: value as ChatRequest["model"] };
        break;
      case "chat.thinking":
        next = { ...next, thinking: value as boolean };
        break;
      case "chat.reasoningEffort":
        next = { ...next, reasoningEffort: value as ChatRequest["reasoningEffort"] };
        break;
      case "chat.systemPrompt":
        next = { ...next, systemPrompt: value as string };
        break;
      default:
        break;
    }
  }
  return { ...next, experiment: assignment };
}

export async function prepareChatRequestWithExperiment(ownerId: string, request: ChatRequest): Promise<ChatRequest> {
  if (request.mode !== "normal" || !request.conversationId || !request.persistence || !request.jobId) return request;
  const row = await assignAbExperiment(ownerId, {
    conversationId: request.conversationId,
    turnId: request.persistence.turnId,
    versionId: request.persistence.versionId,
    jobId: request.jobId,
    retryOfVersionId: request.persistence.retryOfVersionId,
  });
  if (!row) return request;
  const assignment: AbExperimentAssignment = {
    id: row.id,
    experimentId: row.experiment_id,
    experimentName: row.experiment_name,
    variant: row.variant,
    overrides: row.overrides as AbOverridePatch,
    retry: row.retry,
  };
  return applyAbAssignmentToChatRequest(request, assignment);
}

export function abExperimentCatalog(): AbExperimentCatalog {
  const response = runtimeConfigResponse();
  return {
    runtimeDescriptors: response.descriptors,
    runtimeValues: runtimeConfigSnapshot(),
    chatSettings: AB_CHAT_SETTING_DEFINITIONS,
  };
}

export async function listAbExperimentResponse(ownerId: string): Promise<{ experiments: AbExperiment[]; catalog: AbExperimentCatalog }> {
  return { experiments: mapAbExperimentRows(await listAbExperiments(ownerId)) as AbExperiment[], catalog: abExperimentCatalog() };
}

export async function createAbExperimentFromInput(ownerId: string, value: unknown): Promise<string> {
  const mutation = normalizeAbExperimentMutation(value);
  return createAbExperiment(ownerId, mutation.name, mutation.variantA, mutation.variantB);
}

export async function updateAbExperimentStatus(ownerId: string, experimentId: string, status: unknown): Promise<void> {
  if (status !== "active" && status !== "paused" && status !== "completed") throw new AbExperimentValidationError("Experiment status is invalid.");
  if (!(await setAbExperimentStatus(ownerId, experimentId, status))) throw new AbExperimentValidationError("Experiment not found.");
}

export async function removeAbExperiment(ownerId: string, experimentId: string): Promise<void> {
  if (!(await deleteAbExperiment(ownerId, experimentId))) throw new AbExperimentValidationError("Experiment not found.");
}

export async function recordAbVersionPreference(ownerId: string, conversationId: string, turnId: string, versionId: string): Promise<void> {
  await markAbVersionPreferred(ownerId, conversationId, turnId, versionId);
}
