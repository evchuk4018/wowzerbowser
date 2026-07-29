"use client";
import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { CHAT_REASONING_EFFORTS, DEFAULT_CHAT_MODELS, chatModelIdentity, isChatModelRef, type ChatModelInfo, type ChatModelRef, type ChatReasoningEffort } from "../../lib/chat-protocol";
import { DEFAULT_CHAT_MODEL_PREFERENCE, normalizeModelPreference, type ChatModelPreference } from "../../lib/chat-model-preference";
import { fetchChatModels } from "./chat-service";
import { saveChatModelPreference } from "./chat-model-preference-service";

export type ChatPreferences = {
  models: ChatModelInfo[]; model: ChatModelRef; setModel: Dispatch<SetStateAction<ChatModelRef>>;
  thinking: boolean; setThinking: Dispatch<SetStateAction<boolean>>;
  effort: ChatReasoningEffort; setEffort: Dispatch<SetStateAction<ChatReasoningEffort>>;
  selectedModel?: ChatModelInfo; supportedEfforts: ChatReasoningEffort[]; canThink: boolean;
  effectiveThinking: boolean; effectiveEffort: ChatReasoningEffort; modelPreferencesLoaded: boolean;
  modelPreferences: Record<string, ChatModelPreference>;
  persistModelPreference: (preference: ChatModelPreference) => void;
  onPreferenceChange: (preference: ChatModelPreference) => void;
};
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object";
export function normalizeChatModelInfo(value: unknown): ChatModelInfo | null {
  if (!record(value) || !isChatModelRef(value.ref) || typeof value.displayName !== "string") return null;
  const supportedEfforts = Array.isArray(value.supportedEfforts) ? value.supportedEfforts.filter((item): item is ChatReasoningEffort => CHAT_REASONING_EFFORTS.includes(item as ChatReasoningEffort)) : [];
  return {
    ref: value.ref, displayName: value.displayName,
    description: typeof value.description === "string" ? value.description : null,
    author: typeof value.author === "string" ? value.author : null,
    architecture: typeof value.architecture === "string" ? value.architecture : null,
    inputModalities: Array.isArray(value.inputModalities) ? value.inputModalities.filter((item): item is string => typeof item === "string") : [],
    outputModalities: Array.isArray(value.outputModalities) ? value.outputModalities.filter((item): item is string => typeof item === "string") : [],
    toolSupport: value.toolSupport === true,
    supportedParameters: Array.isArray(value.supportedParameters) ? value.supportedParameters.filter((item): item is string => typeof item === "string") : [],
    reasoningRequired: value.reasoningRequired === true, supportedEfforts,
    defaultReasoningEffort: supportedEfforts.includes(value.defaultReasoningEffort as ChatReasoningEffort) ? value.defaultReasoningEffort as ChatReasoningEffort : supportedEfforts[0] ?? null,
    contextLength: typeof value.contextLength === "number" ? value.contextLength : 0,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : null,
    pricing: record(value.pricing) ? value.pricing as ChatModelInfo["pricing"] : null,
  };
}
export function normalizeChatModels(values: unknown): ChatModelInfo[] {
  const models = Array.isArray(values) ? values.map(normalizeChatModelInfo).filter((item): item is ChatModelInfo => Boolean(item)) : [];
  return models.length ? models : DEFAULT_CHAT_MODELS;
}
const findModel = (ref: ChatModelRef, models: ChatModelInfo[]) => models.find((item) => chatModelIdentity(item.ref) === chatModelIdentity(ref));
export type UseChatPreferencesOptions = { activeConversationId: string; getAccessToken: () => Promise<string | null>; initialModelPreferences?: Record<string, ChatModelPreference>; bootstrapComplete?: boolean };
export function useChatPreferences({ activeConversationId, getAccessToken, initialModelPreferences = {}, bootstrapComplete = false }: UseChatPreferencesOptions): ChatPreferences {
  const [models, setModels] = useState<ChatModelInfo[]>(DEFAULT_CHAT_MODELS);
  const [model, setModel] = useState(DEFAULT_CHAT_MODEL_PREFERENCE.model);
  const [thinking, setThinking] = useState(false);
  const [effort, setEffort] = useState<ChatReasoningEffort>("high");
  const [modelPreferences, setModelPreferences] = useState(initialModelPreferences);
  const [modelPreferencesLoaded, setModelPreferencesLoaded] = useState(bootstrapComplete);
  useEffect(() => {
    let active = true;
    const load = () => void getAccessToken().then((token) => token ? fetchChatModels(token) : []).then((items) => { if (active) setModels(normalizeChatModels(items)); }).catch(() => undefined);
    load(); window.addEventListener("chat-models-changed", load);
    return () => { active = false; window.removeEventListener("chat-models-changed", load); };
  }, [getAccessToken]);
  useEffect(() => {
    if (bootstrapComplete || Object.keys(initialModelPreferences).length) {
      // Bootstrap is the authoritative external preference snapshot.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setModelPreferences(initialModelPreferences); setModelPreferencesLoaded(true);
    }
  }, [bootstrapComplete, initialModelPreferences]);
  const selectedModel = useMemo(() => findModel(model, models), [model, models]);
  const supportedEfforts = selectedModel?.supportedEfforts ?? [];
  const canThink = supportedEfforts.length > 0;
  const effectiveThinking = Boolean(selectedModel?.reasoningRequired || (thinking && canThink));
  const effectiveEffort = supportedEfforts.includes(effort) ? effort : selectedModel?.defaultReasoningEffort ?? supportedEfforts[0] ?? "medium";
  useEffect(() => {
    if (!activeConversationId || !modelPreferencesLoaded) return;
    const stored = modelPreferences[activeConversationId] ?? DEFAULT_CHAT_MODEL_PREFERENCE;
    const metadata = findModel(stored.model, models);
    const normalized = metadata ? normalizeModelPreference(stored, metadata) : DEFAULT_CHAT_MODEL_PREFERENCE;
    // Conversation selection synchronizes these controlled values with storage.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setModel(normalized.model); setThinking(normalized.thinking); setEffort(normalized.reasoningEffort);
  }, [activeConversationId, modelPreferences, modelPreferencesLoaded, models]);
  const persistModelPreference = useCallback((preference: ChatModelPreference) => {
    if (!activeConversationId) return;
    const normalized = normalizeModelPreference(preference, findModel(preference.model, models) ?? DEFAULT_CHAT_MODELS[0]);
    setModelPreferences((current) => ({ ...current, [activeConversationId]: normalized }));
    void getAccessToken().then((token) => token ? saveChatModelPreference(activeConversationId, normalized, token) : undefined).catch(() => undefined);
  }, [activeConversationId, getAccessToken, models]);
  return { models, model, setModel, thinking, setThinking, effort, setEffort, selectedModel, supportedEfforts, canThink, effectiveThinking, effectiveEffort, modelPreferencesLoaded, modelPreferences, persistModelPreference, onPreferenceChange: persistModelPreference };
}
