import type { ModelToolDefinition } from "./model-tool-protocol";

export const CONNECTOR_CAPABILITIES = ["search", "read", "write", "destructive", "sync"] as const;
export type ConnectorCapability = (typeof CONNECTOR_CAPABILITIES)[number];
export type ConnectorProviderKind = "managed" | "google_gmail" | "remote_mcp";
export type ConnectorAuthType = "oauth2" | "api_key" | "none";
export type ConnectorAccess = "read" | "write" | "destructive";
export type ApprovalMode = "never" | "always";

export type ConnectorManifest = {
  id: string;
  name: string;
  description: string;
  iconUrl?: string;
  version: string;
  provider: ConnectorProviderKind;
  auth: { type: ConnectorAuthType };
  capabilities: ConnectorCapability[];
  defaultApproval: {
    read: ApprovalMode;
    write: ApprovalMode;
    destructive: "always";
  };
};

export type ConnectorTool = {
  id?: string;
  connectorId: string;
  name: string;
  namespacedName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  access: ConnectorAccess;
  enabled: boolean;
  approvalMode?: "never" | "always";
  connectorVersion: string;
  discoveredAt: string;
  connectionId?: string;
};

export type ConnectorConnection = {
  id: string;
  connectorId: string;
  accountLabel: string | null;
  accountEmail: string | null;
  status: "connected" | "reconnect_required" | "unavailable" | "disconnected";
  isDefault: boolean;
  connectedAt: string | null;
  updatedAt: string | null;
};

export type ConnectorCatalogItem = ConnectorManifest & {
  installed: boolean;
  providerAvailable: boolean;
  connections: ConnectorConnection[];
  enabledToolCount: number;
  error?: string;
};

export type ConnectorApprovalSummary = {
  approvalId: string;
  jobId?: string;
  connectorId: string;
  connectorName: string;
  connectionId: string;
  accountLabel: string | null;
  toolName: string;
  description: string;
  access: ConnectorAccess;
  importantArguments: Record<string, unknown>;
  createdAt: string;
};

export type ConnectorApprovalDecision = "allow_once" | "always_allow" | "deny";

export type ConnectorToolResult = {
  ok: boolean;
  output?: unknown;
  error?: string;
  isError?: boolean;
};

export type ConnectorSearchResult = {
  connectorId: string;
  connectorName: string;
  tools: Array<Pick<ConnectorTool, "namespacedName" | "name" | "description" | "inputSchema" | "access">>;
};

export type ConnectorModelTool = ModelToolDefinition & {
  connectorId: string;
  toolName: string;
};
