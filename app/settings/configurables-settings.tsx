"use client";

import { useEffect, useState } from "react";
import { authFetch } from "../auth/auth-fetch";
import { DEFAULT_AUTOMATION_MODEL } from "../../lib/automation-protocol";
import { chatModelIdentity, type ChatModelInfo, type ChatModelRef } from "../../lib/chat-protocol";

export function ConfigurablesSettings({ hasSession, visionModel, onVisionModelChange, automationModel, onAutomationModelChange, automationThinking, onAutomationThinkingChange }: {
  hasSession: () => Promise<boolean>;
  visionModel: ChatModelRef | null;
  onVisionModelChange: (model: ChatModelRef | null) => void;
  automationModel: ChatModelRef;
  onAutomationModelChange: (model: ChatModelRef) => void;
  automationThinking: boolean;
  onAutomationThinkingChange: (enabled: boolean) => void;
}) {
  const [visionModels, setVisionModels] = useState<ChatModelInfo[]>([]);
  const [automationModels, setAutomationModels] = useState<ChatModelInfo[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  useEffect(() => {
    let active = true;
    void hasSession().then(async (sessionReady) => {
      if (!sessionReady) throw new Error("Your session expired.");
      const [vision, chat] = await Promise.all([authFetch("/api/chat/models?scope=vision"), authFetch("/api/chat/models")]);
      if (!vision.ok || !chat.ok) throw new Error("Models are unavailable.");
      return Promise.all([vision.json(), chat.json()]) as Promise<[{ models?: ChatModelInfo[] }, { models?: ChatModelInfo[] }]>;
    }).then(([vision, chat]) => {
      if (!active) return;
      setVisionModels(vision.models ?? []);
      setAutomationModels((chat.models ?? []).filter((model) => model.toolSupport));
      setStatus("ready");
    }).catch(() => { if (active) setStatus("error"); });
    return () => { active = false; };
  }, [hasSession]);

  return <div className="configurables-settings">
    <div className="settings-panel-heading"><h3>Configurables</h3><p>Choose models used for vision and recurring automations.</p></div>
    <label className="settings-field"><span>Vision model</span><select aria-label="Vision model" value={visionModel ? chatModelIdentity(visionModel) : "auto"} onChange={(event) => {
      onVisionModelChange(visionModels.find((item) => chatModelIdentity(item.ref) === event.target.value)?.ref ?? null);
    }}><option value="auto">Auto (current default)</option>{visionModels.map((model) => <option key={chatModelIdentity(model.ref)} value={chatModelIdentity(model.ref)}>{model.displayName} — {model.ref.model}</option>)}</select><small>Auto uses OpenRouter’s existing automatic fallback chain.</small></label>
    <label className="settings-field"><span>Automation model</span><select aria-label="Automation model" value={chatModelIdentity(automationModel)} onChange={(event) => {
      onAutomationModelChange(automationModels.find((item) => chatModelIdentity(item.ref) === event.target.value)?.ref ?? DEFAULT_AUTOMATION_MODEL);
    }}>
      {!automationModels.some((model) => chatModelIdentity(model.ref) === chatModelIdentity(DEFAULT_AUTOMATION_MODEL)) && <option value={chatModelIdentity(DEFAULT_AUTOMATION_MODEL)}>Qwen 3.7 Flash — qwen/qwen3.7-flash</option>}
      {automationModels.map((model) => <option key={chatModelIdentity(model.ref)} value={chatModelIdentity(model.ref)}>{model.displayName} — {model.ref.model}</option>)}
    </select><small>Qwen 3.7 Flash is the default. Alternatives must be enabled and support tools.</small></label>
    <label className="settings-field settings-toggle-field"><span>Automation reasoning</span><span><input type="checkbox" checked={automationThinking} onChange={(event) => onAutomationThinkingChange(event.target.checked)} />{" "}Show the automation&apos;s thinking trace in its delivered conversation.</span></label>
    {status === "loading" && <p className="settings-status">Loading enabled models…</p>}
    {status === "error" && <p className="settings-status settings-error" role="alert">Models could not be loaded.</p>}
  </div>;
}
