"use client";

import { useCallback, useEffect, useState } from "react";
import type { CustomToolDefinition, CustomToolMutation, CustomToolSummary, CustomToolTestResult } from "../../lib/custom-tool-protocol";
import {
  createCustomTool, deleteCustomTool, fetchCustomTool, fetchCustomTools, testCustomTool, updateCustomTool,
} from "./custom-tools-service";
import {
  disconnectGoogleCalendarConnection,
  fetchGoogleCalendarConnection,
  startGoogleCalendarConnection,
} from "./google-calendar-service";
import type { GoogleCalendarConnection } from "../../lib/google-calendar-protocol";
import type { ConnectorCatalogItem } from "../../lib/connector-protocol";
import {
  disconnectConnectorConnection,
  fetchConnectors,
  startConnectorConnection,
} from "./connectors-service";
import { ConnectorDetailModal } from "./connector-detail-modal";
import { isToolsConnector } from "./connector-placement";
import { ToolConnectorRow } from "./tool-connector-row";

const DEFAULT_SCHEMA = '{\n  "type": "object",\n  "properties": {},\n  "additionalProperties": false\n}';
const DEFAULT_SOURCE = 'import json, sys\n\narguments = json.load(sys.stdin)\nprint(json.dumps({"ok": True}))';
type Draft = {
  id?: string; name: string; description: string; instructions: string; schema: string;
  source: string; enabled: boolean; configuredSecrets: string[]; secretNames: string[];
  secretValues: Record<string, string>; removeSecrets: string[];
};
const blankDraft = (): Draft => ({
  name: "", description: "", instructions: "", schema: DEFAULT_SCHEMA, source: DEFAULT_SOURCE,
  enabled: false, configuredSecrets: [], secretNames: [], secretValues: {}, removeSecrets: [],
});
const draftFor = (tool: CustomToolDefinition): Draft => ({
  id: tool.id, name: tool.name, description: tool.description, instructions: tool.instructions,
  schema: JSON.stringify(tool.inputSchema, null, 2), source: tool.pythonSource, enabled: tool.enabled,
  configuredSecrets: tool.secrets.map((item) => item.name), secretNames: tool.secrets.map((item) => item.name),
  secretValues: {}, removeSecrets: [],
});

export function ToolsSettings({ hasSession, connectorStatus }: { hasSession: () => Promise<boolean>; connectorStatus?: "connected" | "error" }) {
  const [tools, setTools] = useState<CustomToolSummary[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [status, setStatus] = useState<"loading" | "idle" | "saving" | "testing">("loading");
  const [error, setError] = useState("");
  const [sample, setSample] = useState("{}");
  const [testResult, setTestResult] = useState<CustomToolTestResult | null>(null);
  const [calendar, setCalendar] = useState<GoogleCalendarConnection | null>(null);
  const [calendarBusy, setCalendarBusy] = useState(false);
  const [connectors, setConnectors] = useState<ConnectorCatalogItem[]>([]);
  const [selectedConnector, setSelectedConnector] = useState<ConnectorCatalogItem | null>(null);
  const [connectorBusyId, setConnectorBusyId] = useState<string | null>(null);

  const ensureSession = useCallback(async () => {
    const value = await hasSession();
    if (!value) throw new Error("Sign in to manage tools.");
  }, [hasSession]);
  const reload = useCallback(async () => {
    await ensureSession();
    setTools(await fetchCustomTools());
  }, [ensureSession]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        await ensureSession();
        const [values, connection, connectorValues] = await Promise.all([
          fetchCustomTools(),
          fetchGoogleCalendarConnection(),
          fetchConnectors(),
        ]);
        if (active) { setTools(values); setCalendar(connection); setConnectors(connectorValues); }
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : "Tools could not be loaded.");
      } finally {
        if (active) setStatus("idle");
      }
    })();
    return () => { active = false; };
  }, [ensureSession]);

  async function connectCalendar() {
    setCalendarBusy(true); setError("");
    try { await ensureSession(); window.location.assign(await startGoogleCalendarConnection()); }
    catch (reason) {
      setError(reason instanceof Error ? reason.message : "Google Calendar connection could not start.");
      setCalendarBusy(false);
    }
  }

  async function disconnectCalendar() {
    if (!window.confirm("Disconnect Google Calendar? Calendar events will not be changed.")) return;
    setCalendarBusy(true); setError("");
    try {
      await ensureSession();
      await disconnectGoogleCalendarConnection();
      setCalendar({ connected: false, connectedAt: null, updatedAt: null });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Google Calendar could not be disconnected.");
    } finally { setCalendarBusy(false); }
  }

  const refreshConnectors = useCallback(async () => {
    await ensureSession();
    setConnectors(await fetchConnectors());
  }, [ensureSession]);

  async function connectConnector(connectorId: string) {
    setConnectorBusyId(connectorId); setError("");
    try { await ensureSession(); window.location.assign(await startConnectorConnection(connectorId)); }
    catch (reason) {
      setError(reason instanceof Error ? reason.message : "Connection could not start.");
      setConnectorBusyId(null);
    }
  }

  async function disconnectConnector(connector: ConnectorCatalogItem, connectionId: string) {
    if (!window.confirm(`Disconnect ${connector.name}?`)) return;
    setConnectorBusyId(connector.id); setError("");
    try {
      await ensureSession();
      await disconnectConnectorConnection(connector.id, connectionId);
      await refreshConnectors();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Connection could not be disconnected.");
    } finally { setConnectorBusyId(null); }
  }

  async function edit(id: string) {
    setError(""); setTestResult(null); setStatus("loading");
    try { await ensureSession(); setDraft(draftFor(await fetchCustomTool(id))); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The tool could not be loaded."); }
    finally { setStatus("idle"); }
  }

  function mutation(current: Draft): CustomToolMutation {
    let inputSchema: Record<string, unknown>;
    try { inputSchema = JSON.parse(current.schema) as Record<string, unknown>; }
    catch { throw new Error("Input schema must be valid JSON."); }
    return {
      name: current.name, description: current.description, instructions: current.instructions,
      inputSchema, pythonSource: current.source, enabled: current.enabled,
      secrets: Object.fromEntries(Object.entries(current.secretValues).filter(([, value]) => value.length > 0)),
      removeSecrets: current.removeSecrets,
    };
  }

  async function save() {
    if (!draft) return;
    setStatus("saving"); setError("");
    try {
      const saved = draft.id
        ? (await ensureSession(), await updateCustomTool(draft.id, mutation(draft)))
        : (await ensureSession(), await createCustomTool(mutation({ ...draft, enabled: false })));
      setDraft(draftFor(saved)); await reload();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The tool could not be saved."); }
    finally { setStatus("idle"); }
  }

  async function runTest() {
    if (!draft?.id) return;
    setStatus("testing"); setError(""); setTestResult(null);
      try { await ensureSession(); setTestResult(await testCustomTool(draft.id, JSON.parse(sample))); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The test could not be run."); }
    finally { setStatus("idle"); }
  }

  async function remove() {
    if (!draft?.id || !window.confirm(`Delete ${draft.name}? This also deletes its credentials.`)) return;
    setStatus("saving"); setError("");
    try { await ensureSession(); await deleteCustomTool(draft.id); setDraft(null); await reload(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The tool could not be deleted."); }
    finally { setStatus("idle"); }
  }

  if (!draft) return (
    <div className="tools-settings">
      <div className="settings-panel-heading tools-heading">
        <div><h3>Tools</h3><p>Create account-wide Python tools the AI can call automatically.</p></div>
        <button type="button" className="settings-save" onClick={() => { setDraft(blankDraft()); setError(""); }}>Create tool</button>
      </div>
      {connectorStatus === "connected" && <p className="settings-status" role="status">Gmail connected successfully.</p>}
      {connectorStatus === "error" && <p className="settings-status settings-error" role="alert">Gmail could not be connected. Confirm that the Gmail API is enabled and Gmail read-only access was approved, then try again. The server log includes the specific provider error.</p>}
      {error && <p className="settings-status settings-error" role="alert">{error}</p>}
      {status === "loading" && <p className="settings-status" role="status">Loading tools...</p>}
      {calendar && (
        <div className="tool-list-item google-calendar-connection">
          <span>
            <strong>Google Calendar</strong>
            <small>{calendar.connected ? "Connected to your primary calendar." : "Connect to read and manage events when requested."}</small>
          </span>
          <button
            type="button"
            className={calendar.connected ? "settings-cancel" : "settings-save"}
            disabled={calendarBusy}
            onClick={() => void (calendar.connected ? disconnectCalendar() : connectCalendar())}
          >
            {calendarBusy ? "Working..." : calendar.connected ? "Disconnect" : "Connect"}
          </button>
        </div>
      )}
      <section className="tools-connected-services" aria-labelledby="connected-services-heading">
        <div className="settings-panel-heading">
          <div><h4 id="connected-services-heading">Connected services</h4><p>Connect accounts and manage the tools available to the assistant.</p></div>
        </div>
        <div className="tools-list">
          {connectors.filter(isToolsConnector).map((connector) => (
            <ToolConnectorRow
              key={connector.id}
              connector={connector}
              busy={connectorBusyId === connector.id}
              onConnect={() => void connectConnector(connector.id)}
              onDisconnect={(connectionId) => void disconnectConnector(connector, connectionId)}
              onManage={() => setSelectedConnector(connector)}
            />
          ))}
        </div>
      </section>
      <div className="tools-list">
        {tools.map((tool) => (
          <button type="button" className="tool-list-item" key={tool.id} onClick={() => void edit(tool.id)}>
            <span><strong>{tool.name}</strong><small>{tool.description}</small></span>
            <span className={tool.enabled ? "tool-state enabled" : "tool-state"}>{tool.enabled ? "Enabled" : "Disabled"}</span>
          </button>
        ))}
        {status !== "loading" && !tools.length && <p className="settings-status">No custom tools yet.</p>}
      </div>
      {selectedConnector && <ConnectorDetailModal connector={selectedConnector} onClose={() => setSelectedConnector(null)} onChanged={refreshConnectors} />}
    </div>
  );

  const busy = status === "saving" || status === "testing";
  return (
    <div className="tools-settings tool-editor">
      <div className="settings-panel-heading tools-heading">
        <div><button type="button" className="tool-back" onClick={() => setDraft(null)}>← Tools</button><h3>{draft.id ? draft.name : "New tool"}</h3></div>
        <label className="tool-enabled"><input type="checkbox" checked={draft.enabled} disabled={!draft.id}
          onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /> Enabled</label>
      </div>
      {error && <p className="settings-status settings-error" role="alert">{error}</p>}
      <div className="tool-form-grid">
        <label className="settings-field"><span>Name</span><input value={draft.name} maxLength={64} placeholder="google_calendar"
          onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
        <label className="settings-field"><span>Description</span><input value={draft.description} maxLength={1000} placeholder="Create and list calendar events"
          onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
      </div>
      <label className="settings-field"><span>AI usage instructions</span><textarea rows={3} value={draft.instructions}
        placeholder="Explain when and how the AI should call this tool." onChange={(event) => setDraft({ ...draft, instructions: event.target.value })} /></label>
      <label className="settings-field"><span>JSON input schema</span><textarea className="tool-code" rows={9} value={draft.schema}
        spellCheck={false} onChange={(event) => setDraft({ ...draft, schema: event.target.value })} /></label>
      <label className="settings-field"><span>Python source</span><small>Read one JSON value from stdin and print one JSON value to stdout.</small>
        <textarea className="tool-code" rows={12} value={draft.source} spellCheck={false}
          onChange={(event) => setDraft({ ...draft, source: event.target.value })} /></label>
      <fieldset className="tool-secrets"><legend>Environment secrets</legend>
        {draft.secretNames.map((name, index) => {
          const configured = draft.configuredSecrets.includes(name) && !draft.removeSecrets.includes(name);
          return <div className="tool-secret-row" key={`${name}:${index}`}>
            <input aria-label="Secret name" value={name} placeholder="GOOGLE_API_KEY" disabled={configured}
              onChange={(event) => { const names = [...draft.secretNames]; names[index] = event.target.value.toUpperCase(); setDraft({ ...draft, secretNames: names }); }} />
            <input aria-label={`${name || "New"} secret value`} type="password" value={draft.secretValues[name] ?? ""} placeholder={configured ? "Stored securely" : "Secret value"}
              onChange={(event) => setDraft({ ...draft, secretValues: { ...draft.secretValues, [name]: event.target.value } })} />
            <button type="button" onClick={() => setDraft({
              ...draft, secretNames: draft.secretNames.filter((_, item) => item !== index),
              removeSecrets: configured ? [...draft.removeSecrets, name] : draft.removeSecrets,
            })}>{configured ? "Remove" : "Discard"}</button>
          </div>;
        })}
        <button type="button" className="tool-add-secret" onClick={() => setDraft({ ...draft, secretNames: [...draft.secretNames, ""] })}>Add secret</button>
      </fieldset>
      {draft.id && <div className="tool-test">
        <label className="settings-field"><span>Test input</span><textarea className="tool-code" rows={5} value={sample} onChange={(event) => setSample(event.target.value)} /></label>
        <button type="button" className="settings-cancel" disabled={busy} onClick={() => void runTest()}>Run test</button>
        {testResult && <pre className={testResult.ok ? "tool-test-result" : "tool-test-result error"}>{JSON.stringify(testResult, null, 2)}</pre>}
      </div>}
      <div className="tool-editor-actions">
        {draft.id && <button type="button" className="tool-delete" disabled={busy} onClick={() => void remove()}>Delete</button>}
        <span />
        <button type="button" className="settings-cancel" disabled={busy} onClick={() => setDraft(null)}>Cancel</button>
        <button type="button" className="settings-save" disabled={busy} onClick={() => void save()}>{status === "saving" ? "Saving..." : "Save tool"}</button>
      </div>
    </div>
  );
}
