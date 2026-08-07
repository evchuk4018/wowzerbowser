"use client";

import { useEffect, useMemo, useState } from "react";
import { authFetch } from "../auth/auth-fetch";
import { DEFAULT_AUTOMATION_MODEL } from "../../lib/automation-protocol";
import {
  type RuntimeConfigDescriptor,
  type RuntimeConfigKey,
  type RuntimeConfigResponse,
  type RuntimeConfigValues,
} from "../../lib/runtime-config-protocol";
import { chatModelIdentity, type ChatModelInfo, type ChatModelRef } from "../../lib/chat-protocol";

const CATEGORY_LABELS: Record<RuntimeConfigDescriptor["category"], string> = {
  search: "Search",
  chat: "Chat & context",
  providers: "Providers",
  research: "Deep research",
  documents: "Documents",
  agent: "Agent tools",
  worker: "Background worker",
  memory: "Memory",
};

const CATEGORY_ORDER: RuntimeConfigDescriptor["category"][] = [
  "search",
  "chat",
  "research",
  "documents",
  "agent",
  "memory",
  "providers",
  "worker",
];

type ConfigurablesSettingsProps = {
  hasSession: () => Promise<boolean>;
  visionModel: ChatModelRef | null;
  onVisionModelChange: (model: ChatModelRef | null) => void;
  automationModel: ChatModelRef;
  onAutomationModelChange: (model: ChatModelRef) => void;
  onRuntimeConfigChange: (values: Partial<RuntimeConfigValues>) => void;
};

function inputValue(descriptor: RuntimeConfigDescriptor, values: RuntimeConfigValues): string | number {
  const value = values[descriptor.key as RuntimeConfigKey];
  return Array.isArray(value) ? value.join(", ") : value as string | number;
}

function ConfigField({ descriptor, values, restartRequired, onChange }: {
  descriptor: RuntimeConfigDescriptor;
  values: RuntimeConfigValues;
  restartRequired: boolean;
  onChange: (key: RuntimeConfigKey, value: RuntimeConfigValues[RuntimeConfigKey]) => void;
}) {
  const value = values[descriptor.key];
  const label = <span>{descriptor.label}{restartRequired && <small className="configurable-restart">Restart required</small>}</span>;
  const help = <small>{descriptor.description}{descriptor.envName ? ` Environment fallback: ${descriptor.envName}.` : ""}</small>;
  if (descriptor.type === "boolean") {
    return <label className="settings-field settings-toggle-field"><span>{label}</span><span><input type="checkbox" checked={value as boolean} onChange={(event) => onChange(descriptor.key, event.target.checked)} /> {help}</span></label>;
  }
  if (descriptor.type === "list") {
    return <label className="settings-field"><span>{label}</span><input value={inputValue(descriptor, values)} onChange={(event) => onChange(descriptor.key, event.target.value.split(",").map((item) => item.trim()).filter(Boolean))} />{help}</label>;
  }
  return <label className="settings-field"><span>{label}</span><input type={descriptor.type === "integer" || descriptor.type === "number" ? "number" : descriptor.type === "url" ? "url" : "text"} value={inputValue(descriptor, values)} min={descriptor.minimum} max={descriptor.maximum} step={descriptor.type === "number" ? "0.01" : descriptor.type === "integer" ? "1" : undefined} onChange={(event) => {
    const next = descriptor.type === "integer" ? Number.parseInt(event.target.value, 10) : descriptor.type === "number" ? Number.parseFloat(event.target.value) : event.target.value;
    onChange(descriptor.key, next as RuntimeConfigValues[RuntimeConfigKey]);
  }} />{help}</label>;
}

export function ConfigurablesSettings({ hasSession, visionModel, onVisionModelChange, automationModel, onAutomationModelChange, onRuntimeConfigChange }: ConfigurablesSettingsProps) {
  const [visionModels, setVisionModels] = useState<ChatModelInfo[]>([]);
  const [automationModels, setAutomationModels] = useState<ChatModelInfo[]>([]);
  const [runtime, setRuntime] = useState<RuntimeConfigResponse | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [runtimeError, setRuntimeError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void hasSession().then(async (sessionReady) => {
      if (!sessionReady) throw new Error("Your session expired.");
      const [vision, chat, configuration] = await Promise.all([
        authFetch("/api/chat/models?scope=vision"),
        authFetch("/api/chat/models"),
        authFetch("/api/configurables"),
      ]);
      if (!vision.ok || !chat.ok) throw new Error("Models are unavailable.");
      const body = await configuration.json().catch(() => null) as RuntimeConfigResponse | { error?: string } | null;
      if (!configuration.ok || !body || !("values" in body)) throw new Error(body && "error" in body && body.error ? body.error : "Runtime configuration is unavailable.");
      return (Promise.all([vision.json(), chat.json()]) as Promise<[{ models?: ChatModelInfo[] }, { models?: ChatModelInfo[] }]>).then(([visionBody, chatBody]) => ({ visionBody, chatBody, configuration: body }));
    }).then(({ visionBody, chatBody, configuration }) => {
      if (!active) return;
      setVisionModels(visionBody.models ?? []);
      setAutomationModels((chatBody.models ?? []).filter((model) => model.toolSupport));
      setRuntime(configuration);
      setStatus("ready");
    }).catch((error) => {
      if (!active) return;
      setStatus("error");
      setRuntimeError(error instanceof Error ? error.message : "Runtime configuration is unavailable.");
    });
    return () => { active = false; };
  }, [hasSession, onRuntimeConfigChange]);

  const grouped = useMemo(() => {
    const groups = new Map<RuntimeConfigDescriptor["category"], RuntimeConfigDescriptor[]>();
    for (const descriptor of runtime?.descriptors ?? []) {
      const group = groups.get(descriptor.category) ?? [];
      group.push(descriptor);
      groups.set(descriptor.category, group);
    }
    return [...groups.entries()].sort(([left], [right]) => CATEGORY_ORDER.indexOf(left) - CATEGORY_ORDER.indexOf(right));
  }, [runtime]);

  const updateRuntimeValue = (key: RuntimeConfigKey, value: RuntimeConfigValues[RuntimeConfigKey]) => {
    setRuntime((current) => {
      if (!current) return current;
      const values = { ...current.values, [key]: value } as RuntimeConfigValues;
      onRuntimeConfigChange({ [key]: value } as Partial<RuntimeConfigValues>);
      return { ...current, values };
    });
  };

  return <div className="configurables-settings">
    <div className="settings-panel-heading"><h3>Configurables</h3><p>Choose models and control safe runtime behavior for the local providers and worker.</p></div>
    <div className="configurables-subheading"><h4>Models</h4><p>These choices are saved with your chat preferences.</p></div>
    <label className="settings-field"><span>Vision model</span><select aria-label="Vision model" value={visionModel ? chatModelIdentity(visionModel) : "auto"} onChange={(event) => {
      onVisionModelChange(visionModels.find((item) => chatModelIdentity(item.ref) === event.target.value)?.ref ?? null);
    }}><option value="auto">Auto (current default)</option>{visionModels.map((model) => <option key={chatModelIdentity(model.ref)} value={chatModelIdentity(model.ref)}>{model.displayName} — {model.ref.model}</option>)}</select><small>Auto uses OpenRouter’s existing automatic fallback chain.</small></label>
    <label className="settings-field"><span>Automation model</span><select aria-label="Automation model" value={chatModelIdentity(automationModel)} onChange={(event) => {
      onAutomationModelChange(automationModels.find((item) => chatModelIdentity(item.ref) === event.target.value)?.ref ?? DEFAULT_AUTOMATION_MODEL);
    }}>
      {!automationModels.some((model) => chatModelIdentity(model.ref) === chatModelIdentity(DEFAULT_AUTOMATION_MODEL)) && <option value={chatModelIdentity(DEFAULT_AUTOMATION_MODEL)}>Qwen 3.7 Flash — qwen/qwen3.7-flash</option>}
      {automationModels.map((model) => <option key={chatModelIdentity(model.ref)} value={chatModelIdentity(model.ref)}>{model.displayName} — {model.ref.model}</option>)}
    </select><small>Alternatives must be enabled and support tools.</small></label>
    {status === "loading" && <p className="settings-status">Loading runtime configuration…</p>}
    {status === "error" && <p className="settings-status settings-error" role="alert">{runtimeError ?? "Runtime configuration could not be loaded."}</p>}
    {runtime && grouped.map(([category, descriptors]) => <section className="configurables-runtime-group" key={category}>
      <div className="configurables-subheading"><h4>{CATEGORY_LABELS[category]}</h4></div>
      {descriptors.map((descriptor) => <ConfigField key={descriptor.key} descriptor={descriptor} values={runtime.values} restartRequired={runtime.restartRequiredKeys.includes(descriptor.key)} onChange={updateRuntimeValue} />)}
    </section>)}
    {runtime?.restartRequired && <p className="settings-status">Some changes are pending the guarded deployment restart.</p>}
    {runtime && <p className="settings-status">Secrets and infrastructure paths remain deployment-managed and are intentionally not exposed here.</p>}
  </div>;
}
