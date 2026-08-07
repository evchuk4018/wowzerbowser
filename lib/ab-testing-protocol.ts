import type {
  ChatModelRef,
  ChatReasoningEffort,
} from "./chat-protocol";
import type {
  RuntimeConfigDescriptor,
  RuntimeConfigKey,
  RuntimeConfigValues,
} from "./runtime-config-protocol";

export const AB_EXPERIMENT_STATUSES = ["active", "paused", "completed"] as const;
export type AbExperimentStatus = typeof AB_EXPERIMENT_STATUSES[number];
export type AbVariant = "a" | "b";

export type AbChatSettingKey =
  | "chat.model"
  | "chat.thinking"
  | "chat.reasoningEffort"
  | "chat.systemPrompt";

export type AbSettingKey = AbChatSettingKey | `runtime.${RuntimeConfigKey}`;

export type AbSettingValue =
  | ChatModelRef
  | ChatReasoningEffort
  | boolean
  | number
  | string
  | string[];

export type AbOverridePatch = Partial<Record<AbSettingKey, AbSettingValue>>;

export type AbChatSettingDefinition = {
  key: AbChatSettingKey;
  label: string;
  description: string;
  category: "chat";
  type: "model" | "boolean" | "effort" | "text";
};

export const AB_CHAT_SETTING_DEFINITIONS: AbChatSettingDefinition[] = [
  { key: "chat.model", label: "Chat model", description: "The model used for this normal-chat turn.", category: "chat", type: "model" },
  { key: "chat.thinking", label: "Reasoning enabled", description: "Whether the model may use reasoning for this turn.", category: "chat", type: "boolean" },
  { key: "chat.reasoningEffort", label: "Reasoning effort", description: "The requested reasoning effort for this turn.", category: "chat", type: "effort" },
  { key: "chat.systemPrompt", label: "System prompt", description: "The canonical system prompt sent for this turn.", category: "chat", type: "text" },
];

export type AbExperiment = {
  id: string;
  name: string;
  status: AbExperimentStatus;
  variantA: AbOverridePatch;
  variantB: AbOverridePatch;
  createdAt: string;
  updatedAt: string;
  results: {
    a: AbExperimentVariantResult;
    b: AbExperimentVariantResult;
  };
};

export type AbExperimentVariantResult = {
  exposures: number;
  completed: number;
  failed: number;
  selected: number;
  averageOutputTps: number | null;
  averageCostUsd: number | null;
};

export type AbExperimentAssignment = {
  id: string;
  experimentId: string;
  experimentName: string;
  variant: AbVariant;
  overrides: AbOverridePatch;
  retry: boolean;
};

export type AbExperimentCatalog = {
  runtimeDescriptors: RuntimeConfigDescriptor[];
  runtimeValues: RuntimeConfigValues;
  chatSettings: AbChatSettingDefinition[];
};

export type AbExperimentResponse = {
  experiments: AbExperiment[];
  catalog: AbExperimentCatalog;
};

export type AbExperimentMutation = {
  name: string;
  variantA: AbOverridePatch;
  variantB: AbOverridePatch;
};

export function isAbExperimentStatus(value: unknown): value is AbExperimentStatus {
  return typeof value === "string" && AB_EXPERIMENT_STATUSES.includes(value as AbExperimentStatus);
}

export function isAbVariant(value: unknown): value is AbVariant {
  return value === "a" || value === "b";
}

export function isAbSettingKey(value: unknown): value is AbSettingKey {
  return typeof value === "string" && (
    AB_CHAT_SETTING_DEFINITIONS.some((definition) => definition.key === value)
    || value.startsWith("runtime.")
  );
}
