"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AB_CHAT_SETTING_DEFINITIONS,
  type AbExperiment,
  type AbExperimentCatalog,
  type AbExperimentMutation,
  type AbSettingKey,
  type AbSettingValue,
} from "../../lib/ab-testing-protocol";
import {
  CHAT_REASONING_EFFORTS,
  DEFAULT_CHAT_MODELS,
  DEFAULT_CHAT_SYSTEM_PROMPT,
  chatModelIdentity,
  type ChatModelInfo,
  type ChatModelRef,
} from "../../lib/chat-protocol";
import type { RuntimeConfigDescriptor } from "../../lib/runtime-config-protocol";
import { authFetch } from "../auth/auth-fetch";
import {
  clonePatch,
  createAbExperiment,
  deleteAbExperiment,
  fetchAbExperiments,
  updateAbExperimentStatus,
} from "./ab-testing-service";

type SettingRow = {
  key: AbSettingKey;
  a: AbSettingValue;
  b: AbSettingValue;
};

type AbTestingSettingsProps = {
  hasSession: () => Promise<boolean>;
};

const effortLabels: Record<string, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

function runtimeKey(key: AbSettingKey): string | null {
  return key.startsWith("runtime.") ? key.slice("runtime.".length) : null;
}

function displayValue(value: unknown): string {
  if (typeof value === "string") return value.length > 180 ? `${value.slice(0, 177)}...` : value;
  if (Array.isArray(value)) return value.join(", ");
  return JSON.stringify(value);
}

function labelFor(key: AbSettingKey, catalog: AbExperimentCatalog): string {
  const chat = AB_CHAT_SETTING_DEFINITIONS.find((item) => item.key === key);
  if (chat) return chat.label;
  const runtime = catalog.runtimeDescriptors.find((item) => `runtime.${item.key}` === key);
  return runtime?.label ?? key;
}

function runtimeDescriptorFor(key: AbSettingKey, catalog: AbExperimentCatalog): RuntimeConfigDescriptor | null {
  const value = runtimeKey(key);
  return value ? catalog.runtimeDescriptors.find((item) => item.key === value) ?? null : null;
}

function chatTypeFor(key: AbSettingKey) {
  return AB_CHAT_SETTING_DEFINITIONS.find((item) => item.key === key)?.type ?? null;
}

function defaultChatValue(key: AbSettingKey, models: ChatModelInfo[]): AbSettingValue {
  if (key === "chat.model") return models[0]?.ref ?? DEFAULT_CHAT_MODELS[0].ref;
  if (key === "chat.thinking") return true;
  if (key === "chat.reasoningEffort") return "high";
  return DEFAULT_CHAT_SYSTEM_PROMPT;
}

function initialRow(key: AbSettingKey, catalog: AbExperimentCatalog, models: ChatModelInfo[]): SettingRow {
  const runtime = runtimeDescriptorFor(key, catalog);
  const baseline = runtime
    ? catalog.runtimeValues[runtime.key]
    : defaultChatValue(key, models);
  return { key, a: baseline as AbSettingValue, b: baseline as AbSettingValue };
}

function modelValue(value: AbSettingValue): string {
  return typeof value === "object" && value !== null && "provider" in value && "model" in value
    ? chatModelIdentity(value as ChatModelRef)
    : "";
}

function SettingEditor({
  row,
  variant,
  catalog,
  models,
  onChange,
}: {
  row: SettingRow;
  variant: "a" | "b";
  catalog: AbExperimentCatalog;
  models: ChatModelInfo[];
  onChange: (value: AbSettingValue) => void;
}) {
  const value = row[variant];
  const runtime = runtimeDescriptorFor(row.key, catalog);
  const chatType = chatTypeFor(row.key);
  if (runtime?.type === "boolean" || chatType === "boolean") {
    return <span className="ab-inline-control"><span><input type="checkbox" checked={value as boolean} onChange={(event) => onChange(event.target.checked)} /> Enabled</span></span>;
  }
  if (row.key === "chat.model") {
    return <select value={modelValue(value)} onChange={(event) => {
      const model = models.find((item) => chatModelIdentity(item.ref) === event.target.value)?.ref;
      if (model) onChange(model);
    }}>
      {models.map((model) => <option key={chatModelIdentity(model.ref)} value={chatModelIdentity(model.ref)}>{model.displayName} ({model.ref.provider})</option>)}
    </select>;
  }
  if (row.key === "chat.reasoningEffort") {
    return <select value={String(value)} onChange={(event) => onChange(event.target.value as AbSettingValue)}>
      {CHAT_REASONING_EFFORTS.map((effort) => <option key={effort} value={effort}>{effortLabels[effort] ?? effort}</option>)}
    </select>;
  }
  if (runtime?.type === "list") {
    return <input value={Array.isArray(value) ? value.join(", ") : String(value)} onChange={(event) => onChange(event.target.value.split(",").map((item) => item.trim()).filter(Boolean))} />;
  }
  if (runtime?.type === "integer" || runtime?.type === "number") {
    return <input type="number" value={typeof value === "number" && Number.isFinite(value) ? value : ""} min={runtime.minimum} max={runtime.maximum} step={runtime.type === "number" ? "0.01" : "1"} onChange={(event) => onChange(runtime.type === "integer" ? Number.parseInt(event.target.value, 10) : Number.parseFloat(event.target.value))} />;
  }
  if (row.key === "chat.systemPrompt") {
    return <textarea value={String(value)} rows={6} onChange={(event) => onChange(event.target.value)} />;
  }
  return <input type={runtime?.type === "url" ? "url" : "text"} value={String(value)} onChange={(event) => onChange(event.target.value)} />;
}

function ExperimentResult({ experiment }: { experiment: AbExperiment }) {
  return <div className="ab-result-grid" aria-label={`${experiment.name} results`}>
    {(["a", "b"] as const).map((variant) => {
      const result = experiment.results[variant];
      return <div className="ab-result" key={variant}>
        <strong>Variant {variant.toUpperCase()}</strong>
        <span>{result.exposures} exposures · {result.completed} complete</span>
        <span>{result.selected} selected</span>
        <span>{result.averageOutputTps === null ? "—" : `${result.averageOutputTps.toFixed(1)} output t/s average`}</span>
        <span>{result.averageCostUsd === null ? "—" : `$${result.averageCostUsd.toFixed(4)} average cost`}</span>
      </div>;
    })}
  </div>;
}

export function AbTestingSettings({ hasSession }: AbTestingSettingsProps) {
  const [catalog, setCatalog] = useState<AbExperimentCatalog | null>(null);
  const [experiments, setExperiments] = useState<AbExperiment[]>([]);
  const [models, setModels] = useState<ChatModelInfo[]>([]);
  const [name, setName] = useState("");
  const [rows, setRows] = useState<SettingRow[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "saving">("loading");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const sessionReady = await hasSession();
      if (!sessionReady) throw new Error("Your session expired.");
      const [experimentResponse, modelResponse] = await Promise.all([
        fetchAbExperiments(),
        authFetch("/api/chat/models"),
      ]);
      if (!modelResponse.ok) throw new Error("Models are unavailable.");
      const modelBody = await modelResponse.json() as { models?: ChatModelInfo[] };
      setCatalog(experimentResponse.catalog);
      setExperiments(experimentResponse.experiments);
      setModels(modelBody.models?.length ? modelBody.models : DEFAULT_CHAT_MODELS);
      setStatus("ready");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "A/B testing is unavailable.");
      setStatus("ready");
    }
  }, [hasSession]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const options = useMemo(() => {
    if (!catalog) return [];
    const used = new Set(rows.map((row) => row.key));
    return [
      ...catalog.runtimeDescriptors.map((descriptor) => ({ key: `runtime.${descriptor.key}` as AbSettingKey, label: descriptor.label, category: descriptor.category })),
      ...catalog.chatSettings.map((setting) => ({ key: setting.key, label: setting.label, category: setting.category })),
    ].filter((option) => !used.has(option.key));
  }, [catalog, rows]);

  function addSetting() {
    if (!catalog || !options[0]) return;
    setRows((current) => [...current, initialRow(options[0].key, catalog, models)]);
  }

  function updateRow(index: number, variant: "a" | "b", value: AbSettingValue) {
    setRows((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, [variant]: value } : row));
  }

  async function create() {
    if (!catalog || !name.trim() || !rows.length) {
      setError("Add a name and at least one setting before creating the experiment.");
      return;
    }
    setStatus("saving");
    setError(null);
    const mutation: AbExperimentMutation = {
      name: name.trim(),
      variantA: Object.fromEntries(rows.map((row) => [row.key, row.a])),
      variantB: Object.fromEntries(rows.map((row) => [row.key, row.b])),
    };
    try {
      await createAbExperiment(mutation);
      setName("");
      setRows([]);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The experiment could not be created.");
      setStatus("ready");
    }
  }

  async function changeStatus(experiment: AbExperiment, next: "active" | "paused" | "completed") {
    setError(null);
    try {
      await updateAbExperimentStatus(experiment.id, next);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The experiment could not be updated.");
    }
  }

  async function remove(experiment: AbExperiment) {
    if (!window.confirm(`Delete ${experiment.name}? Collected results will be removed.`)) return;
    setError(null);
    try {
      await deleteAbExperiment(experiment.id);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The experiment could not be deleted.");
    }
  }

  return <div className="ab-testing-settings">
    <div className="settings-panel-heading">
      <h3>A/B Testing</h3>
      <p>Compare temporary configuration candidates against your current Configurables. Nothing here changes Configurables.</p>
    </div>
    {error && <p className="settings-status settings-error" role="alert">{error}</p>}
    {status === "loading" && <p className="settings-status" role="status">Loading experiments...</p>}
    {catalog && <>
      <section className="ab-create-panel" aria-labelledby="ab-create-heading">
        <div className="ab-panel-heading"><div><h4 id="ab-create-heading">New experiment</h4><p>One normal-chat turn uses one variant, then the baseline returns.</p></div><button type="button" className="settings-save" onClick={() => void create()} disabled={status === "saving"}>{status === "saving" ? "Saving..." : "Create experiment"}</button></div>
        <label className="settings-field"><span>Name</span><input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} placeholder="SearXNG search configuration" /></label>
        <div className="ab-setting-list">
          {rows.map((row, index) => <div className="ab-setting-row" key={row.key}>
            <div className="ab-setting-row-heading"><strong>{labelFor(row.key, catalog)}</strong><button type="button" className="settings-cancel" onClick={() => setRows((current) => current.filter((_, rowIndex) => rowIndex !== index))}>Remove</button></div>
            <div className="ab-variant-columns">
              <label><span>Configuration A</span><SettingEditor row={row} variant="a" catalog={catalog} models={models} onChange={(value) => updateRow(index, "a", value)} /></label>
              <label><span>Configuration B</span><SettingEditor row={row} variant="b" catalog={catalog} models={models} onChange={(value) => updateRow(index, "b", value)} /></label>
            </div>
          </div>)}
        </div>
        <button type="button" className="settings-cancel" onClick={addSetting} disabled={!options.length}>Add setting</button>
      </section>
      <section className="ab-experiment-list" aria-labelledby="ab-existing-heading">
        <div className="ab-panel-heading"><div><h4 id="ab-existing-heading">Experiments and results</h4><p>Use completed data to decide what to change later in Configurables.</p></div></div>
        {!experiments.length && <p className="settings-status">No experiments yet.</p>}
        {experiments.map((experiment) => <article className="ab-experiment-card" key={experiment.id}>
          <div className="ab-experiment-heading"><div><h5>{experiment.name}</h5><span className={`ab-status ab-status-${experiment.status}`}>{experiment.status}</span></div><div className="ab-experiment-actions">
            {experiment.status === "paused" && <button type="button" onClick={() => void changeStatus(experiment, "active")}>Start</button>}
            {experiment.status === "active" && <button type="button" onClick={() => void changeStatus(experiment, "paused")}>Pause</button>}
            {experiment.status !== "completed" && <button type="button" onClick={() => void changeStatus(experiment, "completed")}>Complete</button>}
            <button type="button" className="settings-cancel" onClick={() => void remove(experiment)}>Delete</button>
          </div></div>
          <div className="ab-patch-summary"><div><strong>A</strong>{Object.entries(clonePatch(experiment.variantA)).map(([key, value]) => <span key={key}>{labelFor(key as AbSettingKey, catalog)}: {displayValue(value)}</span>)}</div><div><strong>B</strong>{Object.entries(clonePatch(experiment.variantB)).map(([key, value]) => <span key={key}>{labelFor(key as AbSettingKey, catalog)}: {displayValue(value)}</span>)}</div></div>
          <ExperimentResult experiment={experiment} />
        </article>)}
      </section>
    </>}
  </div>;
}
