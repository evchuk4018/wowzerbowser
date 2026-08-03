import type { ConnectorCatalogItem, ConnectorConnection, ConnectorTool } from "../../lib/connector-protocol";
import { authFetch } from "../auth/auth-fetch";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await authFetch(path, init);
  const value = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? "Connector request failed.");
  return value;
}

export async function fetchConnectors(): Promise<ConnectorCatalogItem[]> { return (await request<{ connectors: ConnectorCatalogItem[] }>("/api/connectors")).connectors; }
export async function fetchConnectorTools(connectorId: string): Promise<ConnectorTool[]> { return (await request<{ tools: ConnectorTool[] }>(`/api/connectors/${encodeURIComponent(connectorId)}/tools`)).tools; }
export async function fetchConnectorConnections(connectorId: string): Promise<ConnectorConnection[]> { return (await request<{ connections: ConnectorConnection[] }>(`/api/connectors/${encodeURIComponent(connectorId)}/connections`)).connections; }
export async function startConnectorConnection(connectorId: string): Promise<string> { return (await request<{ authorizationUrl: string }>(`/api/connectors/${encodeURIComponent(connectorId)}/connect`, { method: "POST" })).authorizationUrl; }
export async function disconnectConnectorConnection(connectorId: string, connectionId: string): Promise<void> { await request(`/api/connectors/${encodeURIComponent(connectorId)}/connections/${encodeURIComponent(connectionId)}`, { method: "DELETE" }); }
export async function refreshConnectorConnection(connectorId: string, connectionId: string): Promise<void> { await request(`/api/connectors/${encodeURIComponent(connectorId)}/connections/${encodeURIComponent(connectionId)}/refresh`, { method: "POST" }); }
export async function setDefaultConnectorConnection(connectorId: string, connectionId: string): Promise<void> { await request(`/api/connectors/${encodeURIComponent(connectorId)}/connections`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ connectionId }) }); }
export async function updateConnectorTool(connectorId: string, toolName: string, values: { enabled?: boolean; approvalMode?: "never" | "always" }): Promise<void> { await request(`/api/connectors/${encodeURIComponent(connectorId)}/tools/${encodeURIComponent(toolName)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(values) }); }
export async function addMcpServer(values: { name: string; description: string; endpointUrl: string; token?: string }): Promise<ConnectorCatalogItem> { return (await request<{ connector: ConnectorCatalogItem }>("/api/connectors", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(values) })).connector; }
export async function removeMcpServer(connectorId: string): Promise<void> { await request(`/api/connectors/${encodeURIComponent(connectorId)}`, { method: "DELETE" }); }
export async function resolveConnectorApproval(approvalId: string, decision: "allow_once" | "always_allow" | "deny"): Promise<void> { await request(`/api/connectors/approvals/${encodeURIComponent(approvalId)}/resolve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision }) }); }
