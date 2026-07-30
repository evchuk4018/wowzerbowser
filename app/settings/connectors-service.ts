import type { ConnectorCatalogItem, ConnectorConnection, ConnectorTool } from "../../lib/connector-protocol";

async function request<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { authorization: `Bearer ${token}`, ...(init?.headers ?? {}) } });
  const value = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? "Connector request failed.");
  return value;
}

export async function fetchConnectors(token: string): Promise<ConnectorCatalogItem[]> { return (await request<{ connectors: ConnectorCatalogItem[] }>("/api/connectors", token)).connectors; }
export async function fetchConnectorTools(connectorId: string, token: string): Promise<ConnectorTool[]> { return (await request<{ tools: ConnectorTool[] }>(`/api/connectors/${encodeURIComponent(connectorId)}/tools`, token)).tools; }
export async function fetchConnectorConnections(connectorId: string, token: string): Promise<ConnectorConnection[]> { return (await request<{ connections: ConnectorConnection[] }>(`/api/connectors/${encodeURIComponent(connectorId)}/connections`, token)).connections; }
export async function startConnectorConnection(connectorId: string, token: string): Promise<string> { return (await request<{ authorizationUrl: string }>(`/api/connectors/${encodeURIComponent(connectorId)}/connect`, token, { method: "POST" })).authorizationUrl; }
export async function disconnectConnectorConnection(connectorId: string, connectionId: string, token: string): Promise<void> { await request(`/api/connectors/${encodeURIComponent(connectorId)}/connections/${encodeURIComponent(connectionId)}`, token, { method: "DELETE" }); }
export async function refreshConnectorConnection(connectorId: string, connectionId: string, token: string): Promise<void> { await request(`/api/connectors/${encodeURIComponent(connectorId)}/connections/${encodeURIComponent(connectionId)}/refresh`, token, { method: "POST" }); }
export async function setDefaultConnectorConnection(connectorId: string, connectionId: string, token: string): Promise<void> { await request(`/api/connectors/${encodeURIComponent(connectorId)}/connections`, token, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ connectionId }) }); }
export async function updateConnectorTool(connectorId: string, toolName: string, values: { enabled?: boolean; approvalMode?: "never" | "always" }, token: string): Promise<void> { await request(`/api/connectors/${encodeURIComponent(connectorId)}/tools/${encodeURIComponent(toolName)}`, token, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(values) }); }
export async function addMcpServer(values: { name: string; description: string; endpointUrl: string; token?: string }, token: string): Promise<ConnectorCatalogItem> { return (await request<{ connector: ConnectorCatalogItem }>("/api/connectors", token, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(values) })).connector; }
export async function removeMcpServer(connectorId: string, token: string): Promise<void> { await request(`/api/connectors/${encodeURIComponent(connectorId)}`, token, { method: "DELETE" }); }
export async function resolveConnectorApproval(approvalId: string, decision: "allow_once" | "always_allow" | "deny", token: string): Promise<void> { await request(`/api/connectors/approvals/${encodeURIComponent(approvalId)}/resolve`, token, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision }) }); }
