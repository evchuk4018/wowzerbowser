"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  CHAT_MODEL_IDS,
  DEFAULT_CHAT_MODELS,
  type ChatModelId,
  type ChatModelInfo,
  type ChatReasoningEffort,
} from "../../lib/chat-protocol";
import {
  DEFAULT_CHAT_MODEL_PREFERENCE,
  type ChatModelPreference,
} from "../../lib/chat-model-preference";
import {
  fetchChatModels,
} from "./chat-service";
import {
  fetchChatModelPreferences,
  saveChatModelPreference,
} from "./chat-model-preference-service";

export type ChatPreferences = {
  models: ChatModelInfo[];
  model: ChatModelId;
  setModel: Dispatch<SetStateAction<ChatModelId>>;
  thinking: boolean;
  setThinking: Dispatch<SetStateAction<boolean>>;
  effort: ChatReasoningEffort;
  setEffort: Dispatch<SetStateAction<ChatReasoningEffort>>;
  selectedModel?: ChatModelInfo;
  supportedEfforts: ChatReasoningEffort[];
  canThink: boolean;
  effectiveThinking: boolean;
  effectiveEffort: ChatReasoningEffort;
  /** True after the remote per-conversation preferences request settles. */
  modelPreferencesLoaded: boolean;
  /** Persist a preference for the currently selected conversation. */
  persistModelPreference: (preference: ChatModelPreference) => void;
  /** Alias suitable for passing directly to ChatComposer. */
  onPreferenceChange: (preference: ChatModelPreference) => void;
};

const MODEL_ID_SET = new Set<string>(CHAT_MODEL_IDS);
const EFFORTS: ChatReasoningEffort[] = ["high", "max"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Normalize provider data before it enters UI state. */
export function normalizeChatModelInfo(value: unknown): ChatModelInfo | null {
  if (!isRecord(value) || typeof value.id !== "string" || !MODEL_ID_SET.has(value.id)) {
    return null;
  }
  const id = value.id as ChatModelId;
  const supportedEfforts = Array.from(new Set(
    Array.isArray(value.supportedEfforts)
      ? value.supportedEfforts.filter((effort): effort is ChatReasoningEffort =>
          typeof effort === "string" && EFFORTS.includes(effort as ChatReasoningEffort),
        )
      : [],
  ));
  return {
    id,
    label: typeof value.label === "string" && value.label.trim() ? value.label : id,
    thinkingSupported: value.thinkingSupported === true,
    supportedEfforts,
  };
}

/** Normalize a remote model list while retaining the built-in fallback list. */
export function normalizeChatModels(values: unknown): ChatModelInfo[] {
  if (!Array.isArray(values)) return DEFAULT_CHAT_MODELS.map((model) => ({ ...model, supportedEfforts: [...model.supportedEfforts] }));
  const models = values
    .map(normalizeChatModelInfo)
    .filter((model): model is ChatModelInfo => model !== null);
  return models.length
    ? models
    : DEFAULT_CHAT_MODELS.map((model) => ({ ...model, supportedEfforts: [...model.supportedEfforts] }));
}

function modelFor(
  model: ChatModelId,
  models: ChatModelInfo[],
): ChatModelInfo | undefined {
  return models.find((candidate) => candidate.id === model) ?? models[0];
}

function normalizePreference(
  preference: ChatModelPreference,
  models: ChatModelInfo[],
): ChatModelPreference {
  const selected = modelFor(preference.model, models);
  const supportedEfforts = selected?.supportedEfforts ?? [];
  const canThink = Boolean(selected?.thinkingSupported && supportedEfforts.length);
  const reasoningEffort = supportedEfforts.includes(preference.reasoningEffort)
    ? preference.reasoningEffort
    : (supportedEfforts[0] ?? "high");
  return {
    model: selected?.id ?? DEFAULT_CHAT_MODEL_PREFERENCE.model,
    thinking: preference.thinking && canThink,
    reasoningEffort,
  };
}

export type UseChatPreferencesOptions = {
  activeConversationId: string;
  getAccessToken: () => Promise<string | null>;
};

/**
 * Own available model and per-conversation preference state.
 *
 * Network failures are intentionally non-fatal: built-in model capabilities
 * remain available and preferences simply fall back to their defaults.
 */
export function useChatPreferences({
  activeConversationId,
  getAccessToken,
}: UseChatPreferencesOptions): ChatPreferences {
  const [models, setModels] = useState<ChatModelInfo[]>(() => normalizeChatModels(DEFAULT_CHAT_MODELS));
  const [model, setModel] = useState<ChatModelId>(DEFAULT_CHAT_MODEL_PREFERENCE.model);
  const [thinking, setThinking] = useState(DEFAULT_CHAT_MODEL_PREFERENCE.thinking);
  const [effort, setEffort] = useState<ChatReasoningEffort>(DEFAULT_CHAT_MODEL_PREFERENCE.reasoningEffort);
  const [modelPreferences, setModelPreferences] = useState<Record<string, ChatModelPreference>>({});
  const [modelPreferencesLoaded, setModelPreferencesLoaded] = useState(false);

  useEffect(() => {
    let mounted = true;
    void getAccessToken()
      .then((token) => token ? fetchChatModels(token) : [])
      .then((availableModels) => {
        if (mounted && availableModels.length) setModels(normalizeChatModels(availableModels));
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, [getAccessToken]);

  useEffect(() => {
    let mounted = true;
    void getAccessToken()
      .then((token) => token ? fetchChatModelPreferences(token) : {})
      .then((preferences) => {
        if (!mounted) return;
        setModelPreferences(preferences);
        setModelPreferencesLoaded(true);
      })
      .catch(() => {
        if (mounted) setModelPreferencesLoaded(true);
      });
    return () => {
      mounted = false;
    };
  }, [getAccessToken]);

  const selectedModel = useMemo(() => modelFor(model, models), [model, models]);
  const supportedEfforts = useMemo(
    () => selectedModel?.supportedEfforts ?? [],
    [selectedModel],
  );
  const canThink = Boolean(selectedModel?.thinkingSupported && supportedEfforts.length);
  const effectiveThinking = thinking && canThink;
  const effectiveEffort = supportedEfforts.includes(effort)
    ? effort
    : (supportedEfforts[0] ?? "high");

  // A provider can remove a model between loads. Keep state inside the
  // currently available model set, matching the old fallback behavior.
  useEffect(() => {
    if (!models.length || models.some((candidate) => candidate.id === model)) return;
    // The provider response is an external capability change; synchronize the
    // controlled model selection after it arrives.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setModel(models[0].id);
  }, [model, models]);

  useEffect(() => {
    if (!canThink && thinking) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setThinking(false);
    }
    if (canThink && !supportedEfforts.includes(effort)) {
      setEffort(supportedEfforts[0]);
    }
  }, [canThink, effort, supportedEfforts, thinking]);

  // Selecting a conversation restores its persisted preference. Defaults are
  // used for conversations that have never stored a preference.
  useEffect(() => {
    if (!activeConversationId || !modelPreferencesLoaded) return;
    const preference = normalizePreference(
      modelPreferences[activeConversationId] ?? DEFAULT_CHAT_MODEL_PREFERENCE,
      models,
    );
    // Restoring a preference is synchronization with the remote preference
    // store and the newly selected conversation.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setModel(preference.model);
    setThinking(preference.thinking);
    setEffort(preference.reasoningEffort);
  }, [activeConversationId, modelPreferences, modelPreferencesLoaded, models]);

  const persistModelPreference = useCallback((preference: ChatModelPreference) => {
    if (!activeConversationId) return;
    const normalized = normalizePreference(preference, models);
    setModelPreferences((current) => ({ ...current, [activeConversationId]: normalized }));
    void getAccessToken()
      .then((token) => token
        ? saveChatModelPreference(activeConversationId, normalized, token)
        : undefined)
      .catch(() => undefined);
  }, [activeConversationId, getAccessToken, models]);

  return {
    models,
    model,
    setModel,
    thinking,
    setThinking,
    effort,
    setEffort,
    selectedModel,
    supportedEfforts,
    canThink,
    effectiveThinking,
    effectiveEffort,
    modelPreferencesLoaded,
    persistModelPreference,
    onPreferenceChange: persistModelPreference,
  };
}
