import type { ChatToolCall, ChatToolResult } from "../../../lib/chat-protocol";
import type {
  ConnectorAccess,
  ConnectorApprovalDecision,
  ConnectorApprovalSummary,
  ConnectorCatalogItem,
  ConnectorConnection,
  ConnectorManifest,
  ConnectorModelTool,
  ConnectorSearchResult,
  ConnectorTool,
  ConnectorToolResult,
} from "../../../lib/connector-protocol";

export type {
  ConnectorAccess,
  ConnectorApprovalDecision,
  ConnectorApprovalSummary,
  ConnectorCatalogItem,
  ConnectorConnection,
  ConnectorManifest,
  ConnectorModelTool,
  ConnectorSearchResult,
  ConnectorTool,
  ConnectorToolResult,
};

export type ConnectionSession = {
  authorizationUrl: string;
  state: string;
};

export type ConnectorWorkspaceSink = {
  writeStream: (
    path: string,
    source: ReadableStream<Uint8Array>,
    size: number,
    options?: { overwrite?: boolean; expectedSha256?: string },
  ) => Promise<{ size: number; sha256: string }>;
};

export type ConnectorProviderContext = {
  ownerId: string;
  connectorId: string;
  connectionId?: string;
  credentials?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
  /** Optional conversation workspace sink for provider-specific binary imports. */
  workspace?: ConnectorWorkspaceSink;
};

export interface ConnectorProvider {
  createConnectionSession(context: ConnectorProviderContext): Promise<ConnectionSession>;
  completeConnection(context: ConnectorProviderContext & { code: string; state: string }): Promise<{
    accountLabel?: string;
    accountEmail?: string;
    credentials: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }>;
  listTools(context: ConnectorProviderContext): Promise<ConnectorTool[]>;
  callTool(context: ConnectorProviderContext & { tool: ConnectorTool; arguments: Record<string, unknown> }): Promise<ConnectorToolResult>;
  disconnect(context: ConnectorProviderContext): Promise<void>;
}

export type ConnectorExecution = {
  tool: ConnectorTool;
  result: ChatToolResult;
};

export type ConnectorCallContext = {
  ownerId: string;
  conversationId?: string;
  jobId?: string;
  signal?: AbortSignal;
};

export type ConnectorToolCall = ChatToolCall;

export type ConnectorCatalogResponse = { connectors: ConnectorCatalogItem[] };
