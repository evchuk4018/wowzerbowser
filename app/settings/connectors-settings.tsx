"use client";

import { useCallback, useEffect, useState } from "react";
import type { ConnectorCatalogItem } from "../../lib/connector-protocol";
import { fetchConnectors } from "./connectors-service";
import { ConnectorCard } from "./connector-card";
import { ConnectorDetailModal } from "./connector-detail-modal";
import { AddMcpServerModal } from "./add-mcp-server-modal";
import { isToolsConnector } from "./connector-placement";

export function ConnectorsSettings({ hasSession }: { hasSession: () => Promise<boolean> }) {
  const [connectors, setConnectors] = useState<ConnectorCatalogItem[]>([]); const [selected, setSelected] = useState<ConnectorCatalogItem | null>(null); const [adding, setAdding] = useState(false); const [status, setStatus] = useState<"loading" | "ready" | "error">("loading"); const [error, setError] = useState("");
  useEffect(() => { let active = true; void (async () => { try { if (!(await hasSession())) throw new Error("Sign in to manage connectors."); const values = await fetchConnectors(); if (active) { setConnectors(values); setStatus("ready"); } } catch (reason) { if (active) { setStatus("error"); setError(reason instanceof Error ? reason.message : "Connectors could not be loaded."); } } })(); return () => { active = false; }; }, [hasSession]);
  const refresh = useCallback(async () => { if (!(await hasSession())) throw new Error("Sign in to manage connectors."); setConnectors(await fetchConnectors()); }, [hasSession]);
  const externalConnectors = connectors.filter((connector) => !isToolsConnector(connector));
  return <div className="connectors-settings"><div className="settings-panel-heading connectors-heading"><div><h3>Connectors</h3><p>Connect external services and MCP servers the assistant can search and use when relevant.</p></div><button type="button" className="settings-save" onClick={() => setAdding(true)}>Add MCP server</button></div>{error && <p className="settings-status settings-error" role="alert">{error}</p>}{status === "loading" && <p className="settings-status" role="status">Loading connectors…</p>}{status === "ready" && <div className="connector-catalog">{externalConnectors.map((connector) => <ConnectorCard key={connector.id} connector={connector} onOpen={() => setSelected(connector)} />)}{!externalConnectors.length && <p className="settings-status">No connectors are available.</p>}</div>}{adding && <AddMcpServerModal onClose={() => setAdding(false)} onAdded={(connector) => { setConnectors((current) => [...current, connector]); }} />}{selected && <ConnectorDetailModal connector={selected} onClose={() => setSelected(null)} onChanged={refresh} />}</div>;
}
