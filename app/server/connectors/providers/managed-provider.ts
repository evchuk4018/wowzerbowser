import "server-only";

import type { ConnectorManifest } from "../../../../lib/connector-protocol";
import type { ConnectorProvider, ConnectorProviderContext, ConnectionSession } from "../connector-types";
import { redactConnectorError } from "../connector-redaction";
import { classifyConnectorToolAccess } from "../mcp/mcp-tool-discovery";
import { integrationCallbackUrl } from "../../integration-site-url";

function baseUrl(): string {
  const value = process.env.PIPEDREAM_CONNECT_BASE_URL?.trim();
  if (!value) throw new Error("Managed connectors are not configured.");
  return value.replace(/\/$/, "");
}

function headers() {
  const key = process.env.PIPEDREAM_CONNECT_API_KEY?.trim();
  if (!key) throw new Error("Managed connectors are not configured.");
  return { authorization: `Bearer ${key}`, "content-type": "application/json" };
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${baseUrl()}${path}`, { ...init, headers: { ...headers(), ...(init.headers ?? {}) } });
  const value = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(redactConnectorError(typeof value.error === "string" ? value.error : `Managed connector request failed (${response.status}).`));
  return value as T;
}

/** Vendor-specific Pipedream wire details intentionally stay inside this adapter. */
export class ManagedConnectorProvider implements ConnectorProvider {
  constructor(private readonly manifestFor: (id: string) => ConnectorManifest | undefined) {}

  async createConnectionSession(context: ConnectorProviderContext): Promise<ConnectionSession> {
    const clientId = process.env.PIPEDREAM_CONNECT_CLIENT_ID?.trim();
    if (!clientId) throw new Error("Managed connector OAuth is not configured.");
    const value = await request<{authorization_url?: string; authorizationUrl?: string; state?: string}>(`/accounts/${encodeURIComponent(context.connectorId)}/oauth/start`, {
      method: "POST", body: JSON.stringify({ ownerId: context.ownerId, clientId, redirectUri: integrationCallbackUrl("/api/connectors/callback"), state: context.metadata?.state }),
    });
    const authorizationUrl = value.authorization_url ?? value.authorizationUrl;
    if (!authorizationUrl || !value.state) throw new Error("Managed connector returned an invalid authorization session.");
    return { authorizationUrl, state: typeof context.metadata?.state === "string" ? context.metadata.state : value.state };
  }

  async completeConnection(context: ConnectorProviderContext & { code: string; state: string }) {
    const value = await request<{account?: {name?: string; email?: string}; credentials?: Record<string, unknown>; metadata?: Record<string, unknown>}>(`/accounts/${encodeURIComponent(context.connectorId)}/oauth/complete`, {
      method: "POST", body: JSON.stringify({ code: context.code, state: context.state, ownerId: context.ownerId }),
    });
    if (!value.credentials || typeof value.credentials !== "object") throw new Error("Managed connector did not return credentials.");
    return { accountLabel: value.account?.name, accountEmail: value.account?.email, credentials: value.credentials, metadata: value.metadata };
  }

  async listTools(context: ConnectorProviderContext) {
    const value = await request<{ tools?: Array<Record<string, unknown>> }>(`/accounts/${encodeURIComponent(context.connectorId)}/${encodeURIComponent(context.connectionId ?? "default")}/tools`, { method: "POST", body: JSON.stringify({ credentials: context.credentials }) });
    const manifest = this.manifestFor(context.connectorId);
    return (value.tools ?? []).flatMap((tool) => {
      if (typeof tool.name !== "string" || !tool.name.trim()) return [];
      const description = typeof tool.description === "string" ? tool.description : `${manifest?.name ?? context.connectorId} action ${tool.name}`;
      return [{ connectorId: context.connectorId, name: tool.name, namespacedName: "", description, inputSchema: (tool.inputSchema ?? tool.input_schema ?? { type: "object", additionalProperties: true }) as Record<string, unknown>, access: classifyConnectorToolAccess(tool.name, description), enabled: true, connectorVersion: manifest?.version ?? "1.0.0", discoveredAt: new Date().toISOString(), connectionId: context.connectionId }];
    });
  }

  async callTool(context: ConnectorProviderContext & { tool: { name: string }; arguments: Record<string, unknown> }) {
    return request<{ok?: boolean; output?: unknown; result?: unknown; error?: string}>(`/accounts/${encodeURIComponent(context.connectorId)}/${encodeURIComponent(context.connectionId ?? "default")}/tools/call`, {
      method: "POST", body: JSON.stringify({ credentials: context.credentials, name: context.tool.name, arguments: context.arguments }),
    }).then((value) => ({ ok: value.ok !== false, output: value.output ?? value.result, ...(value.error ? { error: redactConnectorError(value.error), isError: true } : {}) }));
  }

  async disconnect(context: ConnectorProviderContext): Promise<void> {
    await request(`/accounts/${encodeURIComponent(context.connectorId)}/${encodeURIComponent(context.connectionId ?? "default")}`, { method: "DELETE", body: JSON.stringify({ credentials: context.credentials }) });
  }
}
