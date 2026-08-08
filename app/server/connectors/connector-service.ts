import "server-only";

import type { ChatToolResult } from "../../../lib/chat-protocol";
import type { ConnectorCatalogItem, ConnectorConnection, ConnectorManifest, ConnectorTool } from "../../../lib/connector-protocol";
import { decryptConnectorCredentials, decryptConnectorMetadata, encryptConnectorCredentials, encryptConnectorMetadata } from "./connector-crypto";
import { redactConnectorError, redactConnectorValue } from "./connector-redaction";
import { connectorManifest, MANAGED_CONNECTOR_MANIFESTS, namespaceConnectorTool, normalizeConnectorId } from "./connector-registry";
import { ManagedConnectorProvider } from "./providers/managed-provider";
import { RemoteMcpProvider } from "./providers/remote-mcp-provider";
import {
  deleteConnection, deleteDefinition, ensureInstallation, ensureManagedDefinition, getConnection, getDefaultConnection, getInstallation,
  getPermission, listConnections, listCustomDefinitions, listTools, markConnection, setDefaultConnection, setPermission,
  updateTool, upsertDefinition, upsertTools, type ConnectorConnectionRow, type ConnectorDefinitionRow, type ConnectorToolRow,
} from "./connector-repository";
import type { ConnectorProvider, ConnectorProviderContext } from "./connector-types";
import { runtimeConfigSnapshot } from "../config/runtime-config-service";
import { GoogleGmailProvider } from "./providers/google-gmail-provider";
import { MicrosoftOutlookProvider } from "./providers/microsoft-outlook-provider";

const managed = new ManagedConnectorProvider((id) => connectorManifest(id));
const googleGmail = new GoogleGmailProvider();
const microsoftOutlook = new MicrosoftOutlookProvider();
const remoteMcp = new RemoteMcpProvider();

function provider(manifest: ConnectorManifest): ConnectorProvider {
  if (manifest.provider === "managed") return managed;
  if (manifest.provider === "google_gmail") return googleGmail;
  if (manifest.provider === "microsoft_outlook") return microsoftOutlook;
  return remoteMcp;
}

function manifestFromRow(row: ConnectorDefinitionRow): ConnectorManifest {
  return { id: row.id, name: row.name, description: row.description, ...(row.icon_url ? { iconUrl: row.icon_url } : {}), version: row.version, provider: row.provider, auth: { type: row.auth_type }, capabilities: Array.isArray(row.capabilities) ? row.capabilities as ConnectorManifest["capabilities"] : [], defaultApproval: row.default_approval as ConnectorManifest["defaultApproval"] };
}

function publicConnection(row: ConnectorConnectionRow): ConnectorConnection {
  return { id: row.id, connectorId: row.connector_id, accountLabel: row.account_label, accountEmail: row.account_email, status: row.status as ConnectorConnection["status"], isDefault: row.is_default, connectedAt: row.connected_at, updatedAt: row.updated_at };
}

function publicTool(row: ConnectorToolRow, manifest: ConnectorManifest): ConnectorTool {
  return { id: row.id, connectorId: row.connector_id, name: row.name, namespacedName: namespaceConnectorTool(row.connector_id, row.name), description: row.description, inputSchema: row.input_schema, access: row.access, enabled: row.enabled, connectorVersion: row.connector_version || manifest.version, discoveredAt: row.discovered_at, ...(row.connection_id ? { connectionId: row.connection_id } : {}) };
}

async function manifestsFor(ownerId: string): Promise<ConnectorManifest[]> {
  const custom = await listCustomDefinitions(ownerId);
  return [...MANAGED_CONNECTOR_MANIFESTS, ...custom.map(manifestFromRow).filter((item) => !MANAGED_CONNECTOR_MANIFESTS.some((managedItem) => managedItem.id === item.id))];
}

export async function listConnectorCatalog(ownerId: string): Promise<ConnectorCatalogItem[]> {
  const manifests = await manifestsFor(ownerId);
  return Promise.all(manifests.map(async (manifest) => {
    try {
      const [installation, connections, tools] = await Promise.all([getInstallation(ownerId, manifest.id), listConnections(ownerId, manifest.id), listTools(ownerId, manifest.id)]);
      return { ...manifest, installed: Boolean(installation?.enabled), providerAvailable: true, connections: connections.map(publicConnection), enabledToolCount: tools.filter((tool) => tool.enabled).length };
    } catch (error) {
      return { ...manifest, installed: false, providerAvailable: false, connections: [], enabledToolCount: 0, error: redactConnectorError(error) };
    }
  }));
}

export async function getConnectorManifestForOwner(ownerId: string, connectorId: string): Promise<ConnectorManifest | null> {
  return (await manifestsFor(ownerId)).find((item) => item.id === connectorId) ?? null;
}

export async function createManagedConnectionSession(ownerId: string, connectorId: string, state: string) {
  const manifest = await getConnectorManifestForOwner(ownerId, connectorId);
  if (!manifest || !["managed", "google_gmail", "microsoft_outlook"].includes(manifest.provider)) throw new Error("Managed connector not found.");
  return provider(manifest).createConnectionSession({ ownerId, connectorId, metadata: { state } });
}

export async function completeManagedConnection(ownerId: string, connectorId: string, code: string, state: string): Promise<string> {
  const manifest = await getConnectorManifestForOwner(ownerId, connectorId);
  if (!manifest || !["managed", "google_gmail", "microsoft_outlook"].includes(manifest.provider)) throw new Error("Managed connector not found.");
  const result = await provider(manifest).completeConnection({ ownerId, connectorId, code, state });
  const connectionId = await createConnection(ownerId, manifest, result.credentials, result.accountLabel, result.accountEmail, result.metadata);
  await discoverConnectorTools(ownerId, connectorId, connectionId);
  return connectionId;
}

export async function createConnection(ownerId: string, manifest: ConnectorManifest, credentials: Record<string, unknown>, accountLabel?: string, accountEmail?: string, metadata?: Record<string, unknown>): Promise<string> {
  const encrypted = encryptConnectorCredentials(credentials);
  const encryptedMetadata = encryptConnectorMetadata(metadata ?? {});
  const { insertConnection } = await import("./connector-repository");
  if (["managed", "google_gmail", "microsoft_outlook"].includes(manifest.provider)) await ensureManagedDefinition(manifest);
  await ensureInstallation(ownerId, manifest.id);
  return insertConnection(ownerId, { connectorId: manifest.id, accountLabel, accountEmail, credentials: encrypted, encryptedMetadata });
}

export async function disconnectConnectorConnection(ownerId: string, connectorId: string, connectionId: string): Promise<void> {
  const manifest = await getConnectorManifestForOwner(ownerId, connectorId);
  const connection = await getConnection(ownerId, connectionId);
  if (!manifest || !connection || connection.connector_id !== connectorId) return;
  await provider(manifest).disconnect({ ownerId, connectorId, connectionId, credentials: decryptConnectorCredentials(connection), metadata: decryptConnectorMetadata(connection) });
  await deleteConnection(ownerId, connectionId);
}

export async function markDefaultConnectorConnection(ownerId: string, connectorId: string, connectionId: string): Promise<void> {
  const connection = await getConnection(ownerId, connectionId);
  if (!connection || connection.connector_id !== connectorId) throw new Error("Connector connection not found.");
  await setDefaultConnection(ownerId, connectorId, connectionId);
}

export async function refreshConnectorConnection(ownerId: string, connectorId: string, connectionId: string): Promise<void> {
  await discoverConnectorTools(ownerId, connectorId, connectionId);
}

export async function discoverConnectorTools(ownerId: string, connectorId: string, connectionId?: string): Promise<ConnectorTool[]> {
  const manifest = await getConnectorManifestForOwner(ownerId, connectorId);
  if (!manifest) throw new Error("Connector not found.");
  const connection = connectionId ? await getConnection(ownerId, connectionId) : await getDefaultConnection(ownerId, connectorId);
  if (!connection || connection.connector_id !== connectorId || connection.status !== "connected") throw new Error("Connect an account before discovering connector tools.");
  try {
    const metadata = decryptConnectorMetadata(connection);
    const context: ConnectorProviderContext = { ownerId, connectorId, connectionId: connection.id, credentials: decryptConnectorCredentials(connection), metadata: { ...metadata, endpointUrl: metadata.endpointUrl, version: manifest.version } };
    const discovered = await provider(manifest).listTools(context);
    const tools = discovered.map((tool) => ({ ...tool, namespacedName: namespaceConnectorTool(connectorId, tool.name), access: tool.access ?? "read" as const }));
    await upsertTools(ownerId, connectorId, connection.id, tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema, access: tool.access, enabled: true, connector_version: manifest.version, discovered_at: tool.discoveredAt })));
    await markConnection(ownerId, connection.id, "connected");
    return tools;
  } catch (error) {
    await markConnection(ownerId, connection.id, "unavailable").catch(() => undefined);
    throw new Error(redactConnectorError(error));
  }
}

export async function listConnectorTools(ownerId: string, connectorId: string): Promise<ConnectorTool[]> {
  const manifest = await getConnectorManifestForOwner(ownerId, connectorId);
  if (!manifest) throw new Error("Connector not found.");
  const cached = await listTools(ownerId, connectorId);
  const allowed = manifest.id === "gmail" ? cached.filter((tool) => tool.access === "read") : cached;
  return Promise.all(allowed.map(async (tool) => ({ ...publicTool(tool, manifest), approvalMode: (await getPermission(ownerId, connectorId, tool.name))?.approval_mode ?? manifest.defaultApproval[tool.access] })));
}

export async function updateConnectorTool(ownerId: string, connectorId: string, toolName: string, values: { enabled?: boolean; approvalMode?: "never" | "always" }): Promise<void> {
  if (values.enabled !== undefined) await updateTool(ownerId, connectorId, toolName, values.enabled);
  if (values.approvalMode !== undefined) await setPermission(ownerId, connectorId, toolName, { approvalMode: values.approvalMode });
}

export async function createRemoteMcpConnector(ownerId: string, input: { name: string; description?: string; endpointUrl: string; token?: string }): Promise<ConnectorCatalogItem> {
  const { assertSafeMcpUrl } = await import("./mcp/mcp-client");
  const endpointUrl = assertSafeMcpUrl(input.endpointUrl);
  const id = `mcp_${normalizeConnectorId(input.name)}_${Math.random().toString(36).slice(2, 8)}`;
  const manifest: ConnectorManifest = { id, name: input.name.trim().slice(0, 120), description: input.description?.trim().slice(0, 500) || "Remote MCP server.", version: "1.0.0", provider: "remote_mcp", auth: { type: input.token ? "api_key" : "none" }, capabilities: ["search", "read", "write", "destructive"], defaultApproval: { read: "never", write: "always", destructive: "always" } };
  await upsertDefinition(ownerId, { id, name: manifest.name, description: manifest.description, icon_url: null, version: manifest.version, provider: manifest.provider, auth_type: manifest.auth.type, capabilities: manifest.capabilities, default_approval: manifest.defaultApproval, endpoint_url: endpointUrl });
  const connectionId = await createConnection(ownerId, manifest, input.token ? { token: input.token } : {}, input.name.trim(), undefined, { endpointUrl });
  await discoverConnectorTools(ownerId, id, connectionId);
  const item = (await listConnectorCatalog(ownerId)).find((connector) => connector.id === id);
  if (!item) throw new Error("Remote MCP server could not be loaded after registration.");
  return item;
}

export async function removeRemoteMcpConnector(ownerId: string, connectorId: string): Promise<void> {
  const manifest = await getConnectorManifestForOwner(ownerId, connectorId);
  if (!manifest || manifest.provider !== "remote_mcp") throw new Error("Remote MCP server not found.");
  for (const connection of await listConnections(ownerId, connectorId)) await disconnectConnectorConnection(ownerId, connectorId, connection.id);
  if (!(await deleteDefinition(ownerId, connectorId))) throw new Error("Remote MCP server not found.");
}

function words(value: string): string[] { return value.toLocaleLowerCase().match(/[a-z0-9_]{2,}/g) ?? []; }

export function connectorModelTool(tool: ConnectorTool): { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } } {
  return { type: "function", function: { name: tool.namespacedName, description: tool.description, parameters: tool.inputSchema } };
}

export async function searchConnectorTools(ownerId: string, query: string, connectorIds?: string[]): Promise<{ result: ChatToolResult; tools: ConnectorTool[] }> {
  const catalog = await listConnectorCatalog(ownerId);
  const allowed = new Set(connectorIds?.length ? connectorIds : catalog.filter((item) => item.installed).map((item) => item.id));
  const queryWords = new Set(words(query));
  const matches: ConnectorTool[] = [];
  for (const item of catalog) {
    if (!allowed.has(item.id)) continue;
    const tools = await listConnectorTools(ownerId, item.id).catch(() => []);
    for (const tool of tools) {
      if (!tool.enabled) continue;
      const score = words(`${item.name} ${tool.name} ${tool.description}`).filter((word) => queryWords.has(word)).length;
      if (score || queryWords.size === 0) matches.push(tool);
    }
  }
  const limited = matches.slice(0, Math.min(runtimeConfigSnapshot().connectorSearchMaxResults, 100));
  const grouped = new Map<string, { connectorId: string; connectorName: string; tools: ConnectorTool[] }>();
  for (const tool of limited) {
    const item = catalog.find((candidate) => candidate.id === tool.connectorId);
    if (!item) continue;
    const group = grouped.get(item.id) ?? { connectorId: item.id, connectorName: item.name, tools: [] };
    group.tools.push(tool); grouped.set(item.id, group);
  }
  return { result: successResult("search_connector_tools", { connectors: [...grouped.values()].map((group) => ({ connectorId: group.connectorId, connectorName: group.connectorName, tools: group.tools.map(({ namespacedName, name, description, inputSchema, access }) => ({ namespacedName, name, description, inputSchema, access })) })) }), tools: limited };
}

function successResult(name: string, output: unknown): ChatToolResult { return { id: "search", name, ok: true, stdout: JSON.stringify(redactConnectorValue(output)), stderr: "" }; }

export class ConnectorApprovalRequiredError extends Error {
  constructor(readonly approvalId: string, readonly summary: import("../../../lib/connector-protocol").ConnectorApprovalSummary) { super("Connector approval is required."); this.name = "ConnectorApprovalRequiredError"; }
}
