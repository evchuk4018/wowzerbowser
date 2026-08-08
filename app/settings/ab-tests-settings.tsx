"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { authFetch } from "../auth/auth-fetch";
import {
  DEFAULT_CHAT_MODELS,
  chatModelIdentity,
  type ChatModelInfo,
  type ChatModelRef,
  type ChatReasoningEffort,
} from "../../lib/chat-protocol";
import { normalizeChatModels } from "../chat/use-chat-preferences";
import {
  createAbTest,
  fetchAbTestState,
  stopAbTest,
  type AbTestState,
  type AbTestTrial,
  type AbTestVariantSnapshot,
} from "./ab-tests-service";

type VariantKey = "a" | "b";

export type AbTestsSettingsProps = {
  hasSession: () => Promise<boolean>;
  defaults: AbTestVariantSnapshot;
};

function modelName(ref: ChatModelRef, models: ChatModelInfo[]) {
  return models.find((item) => chatModelIdentity(item.ref) === chatModelIdentity(ref))?.displayName ?? ref.model;
}

function formatDate(value: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function percentage(wins: number, total: number) {
  return total ? `${Math.round((wins / total) * 100)}%` : "-";
}

function ModelPicker({
  id,
  label,
  value,
  models,
  loading,
  onChange,
}: {
  id: string;
  label: string;
  value: ChatModelRef;
  models: ChatModelInfo[];
  loading: boolean;
  onChange: (value: ChatModelRef) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const listId = `${id}-options`;
  const normalizedQuery = query.trim().toLowerCase();
  const filteredModels = useMemo(() => {
    if (!normalizedQuery) return models;
    return models.filter((model) => [
      model.displayName,
      model.ref.provider,
      model.ref.model,
      model.author ?? "",
      model.architecture ?? "",
    ].join(" ").toLowerCase().includes(normalizedQuery));
  }, [models, normalizedQuery]);

  return (
    <div className="ab-test-model-picker">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="search"
        role="combobox"
        aria-autocomplete="list"
        aria-controls={listId}
        aria-expanded={open}
        aria-label={`${label} search`}
        placeholder="Search by model name or provider"
        value={query}
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}
      />
      <button
        type="button"
        className="ab-test-model-current"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((current) => !current)}
      >
        <span>
          <strong>{modelName(value, models)}</strong>
          <small>{value.provider} / {value.model}</small>
        </span>
        <span aria-hidden="true">{open ? "up" : "down"}</span>
      </button>
      {open && (
        <div id={listId} className="ab-test-model-options" role="listbox" aria-label={`${label} options`}>
          {loading && <span className="ab-test-model-empty">Loading models...</span>}
          {!loading && filteredModels.map((model) => {
            const selected = chatModelIdentity(value) === chatModelIdentity(model.ref);
            return (
              <button
                type="button"
                role="option"
                aria-selected={selected}
                className={selected ? "selected" : ""}
                key={chatModelIdentity(model.ref)}
                onClick={() => {
                  onChange(model.ref);
                  setQuery("");
                  setOpen(false);
                }}
              >
                <strong>{model.displayName}</strong>
                <small>{model.ref.provider} / {model.ref.model}</small>
              </button>
            );
          })}
          {!loading && !filteredModels.length && <span className="ab-test-model-empty">No matching models.</span>}
        </div>
      )}
    </div>
  );
}

function sameSnapshot(left: AbTestVariantSnapshot, right: AbTestVariantSnapshot) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function variantLabel(trial: AbTestTrial, variant: VariantKey, models: ChatModelInfo[]) {
  const snapshot = variant === "a" ? trial.variantA : trial.variantB;
  return `Variant ${variant.toUpperCase()}: ${modelName(snapshot.model, models)}`;
}

function TrialResults({ trial, models, active = false }: { trial: AbTestTrial; models: ChatModelInfo[]; active?: boolean }) {
  const result = trial.aggregate;
  const completed = result.completedComparisons;
  return (
    <section className="ab-test-results" aria-labelledby={`ab-test-results-${trial.id}`}>
      <div className="ab-test-section-heading">
        <div>
          <h4 id={`ab-test-results-${trial.id}`}>{active ? "Current results" : "Completed trial"}</h4>
          <p>{active ? "Preference data updates as you choose between responses." : `Finished ${formatDate(trial.stoppedAt ?? trial.createdAt)}. Variant details are now visible.`}</p>
        </div>
        <span className={`ab-test-status ${active ? "ab-test-status-active" : "ab-test-status-stopped"}`}>{active ? "active" : "stopped"}</span>
      </div>
      <div className="ab-test-variant-summary">
        <div>
          <span>{variantLabel(trial, "a", models)}</span>
          <strong>{percentage(result.variantAWins, completed)}</strong>
          <small>{result.variantAWins} preferred of {completed} completed</small>
        </div>
        <div>
          <span>{variantLabel(trial, "b", models)}</span>
          <strong>{percentage(result.variantBWins, completed)}</strong>
          <small>{result.variantBWins} preferred of {completed} completed</small>
        </div>
        <div>
          <span>Comparisons</span>
          <strong>{result.totalComparisons}</strong>
          <small>{result.pendingComparisons} pending choices</small>
        </div>
      </div>
      <p className="ab-test-result-meta">
        Option A was preferred {percentage(result.optionAWins, completed)} of the time. Sampling rate: {Math.round(trial.samplingRate * 100)}%.
      </p>
    </section>
  );
}

function TrialHistory({ trials, models }: { trials: AbTestTrial[]; models: ChatModelInfo[] }) {
  if (!trials.length) return null;
  return (
    <section className="ab-test-results" aria-labelledby="ab-test-history-heading">
      <div className="ab-test-section-heading">
        <div>
          <h4 id="ab-test-history-heading">Trial history</h4>
          <p>Past trials stay available for comparison over time.</p>
        </div>
      </div>
      <div className="ab-test-history-scroll">
        <table className="ab-test-history">
          <thead>
            <tr>
              <th scope="col">Started</th>
              <th scope="col">Variants</th>
              <th scope="col">Completed</th>
              <th scope="col">Preferred</th>
            </tr>
          </thead>
          <tbody>
            {trials.map((trial) => (
              <tr key={trial.id}>
                <td>{formatDate(trial.createdAt)}</td>
                <td>{modelName(trial.variantA.model, models)} vs {modelName(trial.variantB.model, models)}</td>
                <td>{trial.aggregate.completedComparisons}</td>
                <td>A {percentage(trial.aggregate.variantAWins, trial.aggregate.completedComparisons)} / B {percentage(trial.aggregate.variantBWins, trial.aggregate.completedComparisons)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function AbTestsSettings({ hasSession, defaults }: AbTestsSettingsProps) {
  const [variantA, setVariantA] = useState<AbTestVariantSnapshot>(defaults);
  const [variantB, setVariantB] = useState<AbTestVariantSnapshot>(defaults);
  const [name, setName] = useState("");
  const [models, setModels] = useState<ChatModelInfo[]>(DEFAULT_CHAT_MODELS);
  const [state, setState] = useState<AbTestState | null>(null);
  const [loading, setLoading] = useState(true);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const headingId = useId();

  useEffect(() => {
    let active = true;
    void hasSession().then(async (sessionReady) => {
      if (!sessionReady) throw new Error("Your session expired.");
      const [trialState, modelsResponse] = await Promise.all([
        fetchAbTestState(),
        authFetch("/api/chat/models"),
      ]);
      if (!modelsResponse.ok) throw new Error("Models are unavailable.");
      const body = await modelsResponse.json() as { models?: unknown };
      return { trialState, models: normalizeChatModels(body.models) };
    }).then((result) => {
      if (!active) return;
      setState(result.trialState);
      setModels(result.models);
      setError(null);
    }).catch((reason) => {
      if (active) setError(reason instanceof Error ? reason.message : "A/B testing could not be loaded.");
    }).finally(() => {
      if (!active) return;
      setLoading(false);
      setModelsLoading(false);
    });
    return () => {
      active = false;
    };
  }, [hasSession]);

  const updateVariant = (variant: VariantKey, patch: Partial<AbTestVariantSnapshot>) => {
    const setter = variant === "a" ? setVariantA : setVariantB;
    setter((current) => ({ ...current, ...patch }));
  };

  const changeModel = (variant: VariantKey, model: ChatModelRef) => {
    const metadata = models.find((item) => chatModelIdentity(item.ref) === chatModelIdentity(model));
    const current = variant === "a" ? variantA : variantB;
    updateVariant(variant, {
      model,
      thinking: metadata?.reasoningRequired || (current.thinking && Boolean(metadata?.supportedEfforts.length)),
      reasoningEffort: metadata?.supportedEfforts.includes(current.reasoningEffort)
        ? current.reasoningEffort
        : metadata?.defaultReasoningEffort ?? metadata?.supportedEfforts[0] ?? current.reasoningEffort,
    });
  };

  const reloadState = async () => {
    if (!(await hasSession())) throw new Error("Your session expired.");
    setState(await fetchAbTestState());
  };

  const startTrial = async () => {
    setError(null);
    setNotice(null);
    if (sameSnapshot(variantA, variantB)) {
      setError("Choose at least one different setting for Variant B before starting the trial.");
      return;
    }
    setSaving(true);
    try {
      if (!(await hasSession())) throw new Error("Your session expired.");
      await createAbTest({ name: name.trim() || undefined, variants: { a: variantA, b: variantB } });
      await reloadState();
      setNotice("Trial started. Comparisons will appear on eligible responses.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The A/B trial could not be started.");
    } finally {
      setSaving(false);
    }
  };

  const endTrial = async () => {
    const trial = state?.activeTrial;
    if (!trial) return;
    setError(null);
    setNotice(null);
    setStopping(true);
    try {
      if (!(await hasSession())) throw new Error("Your session expired.");
      await stopAbTest(trial.id);
      await reloadState();
      setNotice("Trial stopped. Its results remain available below.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The A/B trial could not be stopped.");
    } finally {
      setStopping(false);
    }
  };

  const renderVariant = (variant: VariantKey, snapshot: AbTestVariantSnapshot) => {
    const selectedModel = models.find((item) => chatModelIdentity(item.ref) === chatModelIdentity(snapshot.model));
    const efforts = [...new Set<ChatReasoningEffort>([
      ...(selectedModel?.supportedEfforts ?? []),
      snapshot.reasoningEffort,
    ])];
    const prefix = `ab-test-${variant}`;
    return (
      <article className="ab-test-variant" aria-labelledby={`${prefix}-heading`}>
        <div className="ab-test-variant-heading">
          <div>
            <span className="ab-test-variant-kicker">Option {variant.toUpperCase()}</span>
            <h4 id={`${prefix}-heading`}>Variant {variant.toUpperCase()}</h4>
          </div>
          <span className="ab-test-variant-note">Request snapshot</span>
        </div>
        <ModelPicker id={`${prefix}-model`} label="Core model" value={snapshot.model} models={models} loading={modelsLoading} onChange={(model) => changeModel(variant, model)} />
        <div className="ab-test-inline-fields">
          <label className="ab-test-field">
            <span>Reasoning effort</span>
            <select value={snapshot.reasoningEffort} disabled={!efforts.length} onChange={(event) => updateVariant(variant, { reasoningEffort: event.target.value as ChatReasoningEffort })}>
              {efforts.map((effort) => <option value={effort} key={effort}>{effort === "xhigh" ? "Extra high" : effort.charAt(0).toUpperCase() + effort.slice(1)}</option>)}
            </select>
          </label>
          <label className="ab-test-checkbox ab-test-field">
            <span>Thinking</span>
            <span><input type="checkbox" checked={snapshot.thinking} onChange={(event) => updateVariant(variant, { thinking: event.target.checked })} /> Enable reasoning</span>
          </label>
        </div>
        <label className="ab-test-field"><span>System prompt</span><textarea rows={5} maxLength={12000} value={snapshot.systemPrompt} onChange={(event) => updateVariant(variant, { systemPrompt: event.target.value })} /></label>
        <label className="ab-test-field"><span>User presence</span><textarea rows={3} maxLength={12000} placeholder="Optional context about you" value={snapshot.userPresence} onChange={(event) => updateVariant(variant, { userPresence: event.target.value })} /></label>
        <label className="ab-test-checkbox ab-test-field"><span>Context</span><span><input type="checkbox" checked={snapshot.contextMode === "focused"} onChange={(event) => updateVariant(variant, { contextMode: event.target.checked ? "focused" : "full" })} /> Use focused context</span></label>
        <p className="ab-test-field-hint">A/B trials apply to normal chat turns. Deep research continues to use your standard settings.</p>
      </article>
    );
  };

  const activeTrial = state?.activeTrial;
  const completedTrials = state?.trials.filter((trial) => trial.status === "stopped") ?? [];
  return (
    <div className="ab-tests-settings" aria-labelledby={headingId}>
      <div className="settings-panel-heading"><h3 id={headingId}>A/B testing</h3><p>Compare two request configurations in blind, randomized trials. Only one trial can run at a time.</p></div>
      {error && <p className="settings-status settings-error" role="alert">{error}</p>}
      {notice && <p className="settings-status ab-test-notice" role="status">{notice}</p>}
      {loading && <p className="settings-status" role="status">Loading A/B testing...</p>}
      {!loading && activeTrial && (
        <section className="ab-test-active" aria-labelledby="ab-test-active-heading">
          <div>
            <span className="ab-test-status ab-test-status-active">Active trial</span>
            <h4 id="ab-test-active-heading">{activeTrial.name || `${variantLabel(activeTrial, "a", models)} vs ${variantLabel(activeTrial, "b", models)}`}</h4>
            <p>Eligible responses are sampled for comparison. Models are hidden until a preference is recorded.</p>
            <small>Started {formatDate(activeTrial.createdAt)} - {activeTrial.aggregate.totalComparisons} comparisons - {Math.round(activeTrial.samplingRate * 100)}% sample</small>
          </div>
          <button type="button" className="ab-test-secondary-action" disabled={stopping} onClick={() => void endTrial()}>{stopping ? "Stopping..." : "Stop trial"}</button>
        </section>
      )}
      {!loading && activeTrial && <TrialResults trial={activeTrial} models={models} active />}
      {!loading && !activeTrial && (
        <section className="ab-test-create" aria-labelledby="ab-test-create-heading">
          <div className="ab-test-section-heading"><div><h4 id="ab-test-create-heading">Start a trial</h4><p>Each eligible comparison uses the same prompt and context for both variants. Options are randomized per comparison.</p></div></div>
          <label className="ab-test-name-field" htmlFor="ab-test-name"><span>Trial name <small>Optional</small></span><input id="ab-test-name" maxLength={120} placeholder="For example, DeepSeek vs Qwen" value={name} onChange={(event) => setName(event.target.value)} /></label>
          <div className="ab-test-variants">{renderVariant("a", variantA)}{renderVariant("b", variantB)}</div>
          {sameSnapshot(variantA, variantB) && <p className="ab-test-form-hint">Make at least one change between the two variants to create a meaningful comparison.</p>}
          <div className="ab-test-form-actions"><button type="button" className="settings-save" disabled={saving || sameSnapshot(variantA, variantB)} onClick={() => void startTrial()}>{saving ? "Starting..." : "Start trial"}</button></div>
        </section>
      )}
      {!loading && completedTrials.map((trial) => <TrialResults key={trial.id} trial={trial} models={models} />)}
      {!loading && <TrialHistory trials={completedTrials} models={models} />}
      {!loading && !completedTrials.length && !activeTrial && <p className="ab-test-empty">No completed trials yet. Start one above to collect preference data.</p>}
      <p className="ab-test-footnote">Outside a trial, your normal chat settings continue to apply. Global worker settings are not changed by this UI.</p>
    </div>
  );
}
