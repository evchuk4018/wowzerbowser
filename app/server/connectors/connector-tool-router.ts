import "server-only";

import type { ChatToolCall, ChatToolResult } from "../../../lib/chat-protocol";
import type { ConnectorTool } from "../../../lib/connector-protocol";
import { connectorManifest, namespaceConnectorTool } from "./connector-registry";
import { connectorModelTool, discoverConnectorTools, getConnectorManifestForOwner } from "./connector-service";
import { requestConnectorApproval, waitForConnectorApproval } from "./connector-approval-service";
import { auditConnectorCall } from "./connector-audit-service";
import { getPermission } from "./connector-repository";
import { decryptConnectorCredentials } from "./connector-crypto";
import { redactConnectorError, redactConnectorValue } from "./connector-redaction";
import { requiresConnectorApproval } from "./connector-policy";
import { ManagedConnectorProvider } from "./providers/managed-provider";
import { RemoteMcpProvider } from "./providers/remote-mcp-provider";
import { GoogleGmailProvider } from "./providers/google-gmail-provider";
import { MicrosoftOutlookProvider } from "./providers/microsoft-outlook-provider";

export const SEARCH_CONNECTOR_TOOLS_NAME = "search_connector_tools";
export const SEARCH_CONNECTOR_TOOLS_DEFINITION = {
  type: "function" as const,
  function: {
    name: SEARCH_CONNECTOR_TOOLS_NAME,
    description: "Find the small set of connected service actions relevant to the user's request. Discover actions before calling a connector.",
    parameters: { type: "object", additionalProperties: false, required: ["query"], properties: { query: { type: "string", minLength: 1, maxLength: 500 }, connectorIds: { type: "array", maxItems: 8, items: { type: "string" } } } },
  },
};

function failed(call: ChatToolCall, message: string): ChatToolResult { return { id: call.id, name: call.name, ok: false, stdout: "", stderr: message.slice(0, 500) }; }

function parsedArguments(call: ChatToolCall): Record<string, unknown> {
  const value = JSON.parse(call.arguments || "{}");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Connector arguments must be a JSON object.");
  return value as Record<string, unknown>;
}

export async function executeSearchConnectorTools(call: ChatToolCall, ownerId: string) {
  try {
    const input = parsedArguments(call);
    const query = typeof input.query === "string" ? input.query.trim() : "";
    if (!query) throw new Error("query is required.");
    const connectorIds = Array.isArray(input.connectorIds) ? input.connectorIds.filter((item): item is string => typeof item === "string") : undefined;
    const found = await import("./connector-service").then(({ searchConnectorTools }) => searchConnectorTools(ownerId, query, connectorIds));
    return { result: { ...found.result, id: call.id, name: call.name }, tools: found.tools };
  } catch (error) { return { result: failed(call, redactConnectorError(error)), tools: [] as ConnectorTool[] }; }
}

function providerFor(id: string, provider: "managed" | "google_gmail" | "microsoft_outlook" | "remote_mcp") {
  if (provider === "managed") return new ManagedConnectorProvider((connectorId) => connectorManifest(connectorId));
  if (provider === "google_gmail") return new GoogleGmailProvider();
  if (provider === "microsoft_outlook") return new MicrosoftOutlookProvider();
  return new RemoteMcpProvider();
}

export async function executeConnectorTool(call: ChatToolCall, context: { ownerId: string; conversationId?: string; jobId?: string; signal?: AbortSignal; onApproval?: (summary: import("../../../lib/connector-protocol").ConnectorApprovalSummary) => Promise<void> }): Promise<ChatToolResult> {
  const startedAt = Date.now();
  try {
    const separator = call.name.indexOf("__", "connector__".length);
    if (!call.name.startsWith("connector__") || separator < 0) return failed(call, `Unknown connector tool: ${call.name}`);
    const connectorId = call.name.slice("connector__".length, separator);
    const manifest = await getConnectorManifestForOwner(context.ownerId, connectorId);
    if (!manifest) return failed(call, "Connector is not available.");
    const connection = await import("./connector-repository").then(({ getDefaultConnection }) => getDefaultConnection(context.ownerId, connectorId));
    if (!connection || connection.status !== "connected") return failed(call, "This connector account is disconnected or needs to be reconnected.");
    const cached = await import("./connector-repository").then(({ listTools }) => listTools(context.ownerId, connectorId));
    let row = cached.find((tool) => namespaceConnectorTool(connectorId, tool.name) === call.name);
    if (!row) {
      const discovered = await discoverConnectorTools(context.ownerId, connectorId, connection.id);
      row = discovered.find((tool) => tool.namespacedName === call.name) as typeof row;
    }
    if (!row || row.enabled === false || (connectorId === "gmail" && row.access !== "read") || (await getPermission(context.ownerId, connectorId, row.name))?.enabled === false) return failed(call, "This connector tool is disabled.");
    const tool: ConnectorTool = { id: row.id, connectorId: row.connector_id, name: row.name, namespacedName: call.name, description: row.description, inputSchema: row.input_schema, access: row.access, enabled: row.enabled, connectorVersion: row.connector_version, discoveredAt: row.discovered_at, ...(row.connection_id ? { connectionId: row.connection_id } : {}) };
    const argumentsValue = parsedArguments(call);
    if (await requiresConnectorApproval(context.ownerId, manifest, row.name, row.access)) {
      const approval = await requestConnectorApproval({ ownerId: context.ownerId, jobId: context.jobId, conversationId: context.conversationId, connectorId, connectionId: connection.id, connectorName: manifest.name, accountLabel: connection.account_label, toolName: row.name, description: row.description, access: row.access, arguments: argumentsValue });
      await context.onApproval?.(approval.summary);
      const decision = await waitForConnectorApproval(context.ownerId, approval.id, context.signal);
      if (decision === "deny") return failed(call, "The user denied this connector action.");
    }
    const provider = providerFor(connectorId, manifest.provider);
    const result = await provider.callTool({ ownerId: context.ownerId, connectorId, connectionId: connection.id, credentials: decryptConnectorCredentials(connection), metadata: { ...connection.metadata, endpointUrl: connection.metadata.endpointUrl, version: manifest.version }, tool, arguments: argumentsValue, signal: context.signal });
    const chatResult: ChatToolResult = { id: call.id, name: call.name, ok: result.ok, stdout: result.output === undefined ? "" : JSON.stringify(redactConnectorValue(result.output)), stderr: result.error ? redactConnectorError(result.error) : "", ...(result.isError ? { exitCode: 1 } : {}) };
    await auditConnectorCall({ ownerId: context.ownerId, connectorId, connectionId: connection.id, toolName: row.name, access: row.access, arguments: argumentsValue, ok: result.ok, error: result.error, durationMs: Date.now() - startedAt });
    return chatResult;
  } catch (error) {
    await auditConnectorCall({ ownerId: context.ownerId, connectorId: call.name.split("__")[1] ?? "unknown", connectionId: "00000000-0000-0000-0000-000000000000", toolName: call.name, access: "unknown", arguments: {}, ok: false, error, durationMs: Date.now() - startedAt });
    return failed(call, redactConnectorError(error));
  }
}

export function connectorToolsToModelTools(tools: ConnectorTool[]) { return tools.filter((tool) => tool.enabled).map(connectorModelTool); }
