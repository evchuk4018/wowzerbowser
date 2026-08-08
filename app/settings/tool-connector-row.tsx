"use client";

import type { ConnectorCatalogItem } from "../../lib/connector-protocol";

type ToolConnectorRowProps = {
  connector: ConnectorCatalogItem;
  busy?: boolean;
  onConnect: () => void;
  onDisconnect: (connectionId: string) => void;
  onManage: () => void;
};

export function ToolConnectorRow({ connector, busy = false, onConnect, onDisconnect, onManage }: ToolConnectorRowProps) {
  const connectedConnection = connector.connections.find((connection) => connection.status === "connected");
  const reconnectRequired = connector.connections.some((connection) => connection.status === "reconnect_required");
  const connection = connectedConnection ?? connector.connections.find((item) => item.status === "reconnect_required");
  const account = connectedConnection?.accountEmail ?? connectedConnection?.accountLabel;
  const description = connectedConnection
    ? `Connected to ${account ?? "your account"}.`
    : reconnectRequired
      ? "Reconnect to continue reading messages."
      : "Connect to read messages when requested.";

  return (
    <div className="tool-list-item tool-connector-row">
      <span>
        <strong>{connector.name}</strong>
        <small>{description}</small>
      </span>
      <span className="tool-connector-actions">
        <button
          type="button"
          className={connectedConnection ? "settings-cancel" : "settings-save"}
          disabled={busy}
          onClick={() => void (connectedConnection && connection ? onDisconnect(connection.id) : onConnect())}
        >
          {busy ? "Working..." : connectedConnection ? "Disconnect" : reconnectRequired ? "Reconnect" : "Connect"}
        </button>
        <button type="button" className="settings-cancel" disabled={busy} onClick={onManage}>
          Manage tools
        </button>
      </span>
    </div>
  );
}
