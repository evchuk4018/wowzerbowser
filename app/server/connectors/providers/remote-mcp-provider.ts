import "server-only";

import type { ConnectorProvider, ConnectorProviderContext } from "../connector-types";
import { McpClient } from "../mcp/mcp-client";
import { discoveredMcpTools } from "../mcp/mcp-tool-discovery";
import { normalizeMcpResult } from "../mcp/mcp-result-normalizer";

export class RemoteMcpProvider implements ConnectorProvider {
  async createConnectionSession(): Promise<never> { throw new Error("Remote MCP servers use their configured endpoint credentials."); }
  async completeConnection(): Promise<never> { throw new Error("Remote MCP servers do not use the managed OAuth callback."); }

  private client(context: ConnectorProviderContext): McpClient {
    const endpoint = typeof context.metadata?.endpointUrl === "string" ? context.metadata.endpointUrl : "";
    return new McpClient(endpoint, context.credentials);
  }

  async listTools(context: ConnectorProviderContext) {
    const client = this.client(context);
    await client.initialize();
    return discoveredMcpTools(context.connectorId, typeof context.metadata?.version === "string" ? context.metadata.version : "1.0.0", await client.listTools());
  }

  async callTool(context: ConnectorProviderContext & { tool: { name: string }; arguments: Record<string, unknown> }) {
    const client = this.client(context);
    await client.initialize();
    return normalizeMcpResult(await client.callTool(context.tool.name, context.arguments));
  }

  async disconnect(): Promise<void> {}
}
