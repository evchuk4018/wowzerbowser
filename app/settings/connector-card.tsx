"use client";

import type { ConnectorCatalogItem } from "../../lib/connector-protocol";

export function ConnectorCard({ connector, onOpen }: { connector: ConnectorCatalogItem; onOpen: () => void }) {
  const connected = connector.connections.some((connection) => connection.status === "connected");
  const reconnect = connector.connections.some((connection) => connection.status === "reconnect_required");
  return <button type="button" className="connector-card" onClick={onOpen}>
    <span className="connector-card-icon" aria-hidden="true">{connector.name.slice(0, 1)}</span>
    <span className="connector-card-copy"><strong>{connector.name}</strong><small>{connector.description}</small><span className="connector-card-meta"><span className={reconnect ? "connector-state reconnect" : connected ? "connector-state connected" : "connector-state"}>{reconnect ? "Reconnect required" : connected ? "Connected" : "Disconnected"}</span><span>{connector.enabledToolCount} tools</span></span></span>
    <span aria-hidden="true">›</span>
  </button>;
}
