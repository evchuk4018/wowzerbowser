"use client";

import { useEffect, useState } from "react";
import { chatModelIdentity, type ChatModelInfo, type ChatModelRef } from "../../lib/chat-protocol";

export function ConfigurablesSettings({ getAccessToken, visionModel, onVisionModelChange }: {
  getAccessToken: () => Promise<string | null>;
  visionModel: ChatModelRef | null;
  onVisionModelChange: (model: ChatModelRef | null) => void;
}) {
  const [models, setModels] = useState<ChatModelInfo[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let active = true;
    void getAccessToken()
      .then((token) => fetch("/api/chat/models?scope=vision", { headers: { authorization: `Bearer ${token}` } }))
      .then(async (response) => {
        if (!response.ok) throw new Error("Vision models are unavailable.");
        return response.json() as Promise<{ models?: ChatModelInfo[] }>;
      })
      .then((body) => {
        if (!active) return;
        setModels(Array.isArray(body.models) ? body.models : []);
        setStatus("ready");
      })
      .catch(() => { if (active) setStatus("error"); });
    return () => { active = false; };
  }, [getAccessToken]);

  const selected = visionModel ? chatModelIdentity(visionModel) : "auto";
  return <div className="configurables-settings">
    <div className="settings-panel-heading"><h3>Configurables</h3><p>Choose the model used for image analysis, image questions, and PDF OCR.</p></div>
    <label className="settings-field">
      <span>Vision model</span>
      <select aria-label="Vision model" value={selected} onChange={(event) => {
        const model = models.find((item) => chatModelIdentity(item.ref) === event.target.value);
        onVisionModelChange(model?.ref ?? null);
      }}>
        <option value="auto">Auto (current default)</option>
        {models.map((model) => <option key={chatModelIdentity(model.ref)} value={chatModelIdentity(model.ref)}>{model.displayName} — {model.ref.model}</option>)}
      </select>
      <small>Auto uses OpenRouter’s existing automatic fallback chain. Enable additional image-capable models in Models first.</small>
    </label>
    {status === "loading" && <p className="settings-status">Loading enabled vision models…</p>}
    {status === "error" && <p className="settings-status settings-error" role="alert">Vision models could not be loaded.</p>}
    {status === "ready" && !models.length && <p className="settings-status">No enabled custom vision models are available.</p>}
  </div>;
}
