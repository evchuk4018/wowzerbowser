"use client";

import { useCallback, useEffect, useState } from "react";
import type { ConnectorCatalogItem } from "../../lib/connector-protocol";
import { fetchConnectors } from "./connectors-service";
import { ConnectorCard } from "./connector-card";
import { ConnectorDetailModal } from "./connector-detail-modal";
import { AddMcpServerModal } from "./add-mcp-server-modal";

export function ConnectorsSettings({ getAccessToken }: { getAccessToken: () => Promise<string | null> }) {
  const [connectors, setConnectors] = useState<ConnectorCatalogItem[]>([]); const [selected, setSelected] = useState<ConnectorCatalogItem | null>(null); const [adding, setAdding] = useState(false); const [status, setStatus] = useState<"loading" | "ready" | "error">("loading"); const [error, setError] = useState(""); const [accessToken, setAccessToken] = useState("");
  useEffect(() => { let active = true; void (async () => { try { const token = await getAccessToken(); if (!token) throw new Error("Sign in to manage connectors."); const values = await fetchConnectors(token); if (active) { setAccessToken(token); setConnectors(values); setStatus("ready"); } } catch (reason) { if (active) { setStatus("error"); setError(reason instanceof Error ? reason.message : "Connectors could not be loaded."); } } })(); return () => { active = false; }; }, [getAccessToken]);
  const refresh = useCallback(async () => { const token = await getAccessToken(); if (!token) throw new Error("Sign in to manage connectors."); setAccessToken(token); setConnectors(await fetchConnectors(token)); }, [getAccessToken]);
  return <div className="connectors-settings"><div className="settings-panel-heading connectors-heading"><div><h3>Connectors</h3><p>Connect services the assistant can search and use when relevant.</p></div><button type="button" className="settings-save" onClick={() => setAdding(true)}>Add MCP server</button></div>{error && <p className="settings-status settings-error" role="alert">{error}</p>}{status === "loading" && <p className="settings-status" role="status">Loading connectors…</p>}{status === "ready" && <div className="connector-catalog">{connectors.map((connector) => <ConnectorCard key={connector.id} connector={connector} onOpen={() => setSelected(connector)} />)}{!connectors.length && <p className="settings-status">No connectors are available.</p>}</div>}{adding && <AddMcpServerModal token={accessToken} onClose={() => setAdding(false)} onAdded={(connector) => { setConnectors((current) => [...current, connector]); }} />}{selected && <ConnectorDetailModal connector={selected} token={accessToken} onClose={() => setSelected(null)} onChanged={refresh} />}</div>;
}
