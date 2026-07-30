"use client";

import { useState } from "react";
import { addMcpServer } from "./connectors-service";
import type { ConnectorCatalogItem } from "../../lib/connector-protocol";

export function AddMcpServerModal({ token, onClose, onAdded }: { token: string; onClose: () => void; onAdded: (connector: ConnectorCatalogItem) => void }) {
  const [draft, setDraft] = useState({ name: "", description: "", endpointUrl: "", token: "" });
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  async function save() { setBusy(true); setError(""); try { onAdded(await addMcpServer(draft, token)); onClose(); } catch (reason) { setError(reason instanceof Error ? reason.message : "MCP server could not be added."); } finally { setBusy(false); } }
  return <div className="settings-submodal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="settings-submodal" role="dialog" aria-modal="true" aria-labelledby="add-mcp-title"><h3 id="add-mcp-title">Add MCP Server</h3><p>Connect a remote streamable HTTP MCP server. HTTPS and public-network protections apply.</p>{error && <p className="settings-status settings-error" role="alert">{error}</p>}<label className="settings-field"><span>Name</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label><label className="settings-field"><span>Description</span><input value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label><label className="settings-field"><span>HTTPS endpoint</span><input type="url" value={draft.endpointUrl} placeholder="https://example.com/mcp" onChange={(event) => setDraft({ ...draft, endpointUrl: event.target.value })} /></label><label className="settings-field"><span>Bearer/API key <small>(optional)</small></span><input type="password" value={draft.token} autoComplete="off" onChange={(event) => setDraft({ ...draft, token: event.target.value })} /></label><div className="settings-actions"><button type="button" className="settings-cancel" onClick={onClose}>Cancel</button><button type="button" className="settings-save" disabled={busy || !draft.name.trim() || !draft.endpointUrl.trim()} onClick={() => void save()}>{busy ? "Connecting…" : "Add server"}</button></div></section></div>;
}
