import "server-only";

import type { ConnectorProvider, ConnectorProviderContext } from "../connector-types";
import { redactConnectorError } from "../connector-redaction";
import { McpClient } from "../mcp/mcp-client";
import { discoveredMcpTools, classifyConnectorToolAccess } from "../mcp/mcp-tool-discovery";
import { normalizeMcpResult } from "../mcp/mcp-result-normalizer";

export const LOCAL_DRIVE_CONNECTOR_ID = "local_drive";
export const LOCAL_DRIVE_MCP_ENDPOINT = "https://homelab.tail861ffd.ts.net/drive/mcp";
export const LOCAL_DRIVE_HEALTH_ENDPOINT = "https://homelab.tail861ffd.ts.net/drive/api/health";
export const LOCAL_DRIVE_VERSION = "1.0.0";

const LOCAL_DRIVE_TOOL_DESCRIPTIONS: Record<string, string> = {
  drive_list: "List files and folders in a Local Drive folder.",
  drive_search: "Search Local Drive files and folders by name or content.",
  drive_get_metadata: "Read metadata for a Local Drive file or folder.",
  drive_read_text: "Read the text content of a Local Drive file.",
  drive_write_file: "Write or replace a text file in Local Drive.",
  drive_create_folder: "Create a folder in Local Drive.",
  drive_rename_item: "Rename a Local Drive file or folder.",
  drive_move_item: "Move a Local Drive file or folder to another folder.",
  drive_trash_item: "Move a Local Drive file or folder to trash.",
  drive_restore_item: "Restore a Local Drive file or folder from trash.",
  drive_delete_permanently: "Permanently delete a Local Drive file or folder. This always requires explicit approval.",
};

const LOCAL_DRIVE_READ_TOOLS = new Set(["drive_list", "drive_search", "drive_get_metadata", "drive_read_text"]);
const LOCAL_DRIVE_WRITE_TOOLS = new Set(["drive_write_file", "drive_create_folder", "drive_rename_item", "drive_move_item"]);
const LOCAL_DRIVE_DESTRUCTIVE_TOOLS = new Set(["drive_trash_item", "drive_restore_item", "drive_delete_permanently"]);

export function classifyLocalDriveToolAccess(name: string, description: string): "read" | "write" | "destructive" {
  if (LOCAL_DRIVE_READ_TOOLS.has(name)) return "read";
  if (LOCAL_DRIVE_WRITE_TOOLS.has(name)) return "write";
  if (LOCAL_DRIVE_DESTRUCTIVE_TOOLS.has(name)) return "destructive";
  return classifyConnectorToolAccess(name, description);
}

export function localDriveToolDescription(name: string, description?: string): string {
  return LOCAL_DRIVE_TOOL_DESCRIPTIONS[name] ?? description?.trim().slice(0, 2_000) ?? `Local Drive action ${name}.`;
}

function configuredToken(): string {
  const token = process.env.LOCAL_DRIVE_API_TOKEN?.trim();
  if (!token) throw new Error("Local Drive is not configured.");
  return token;
}

/** Local Drive is deployment-authenticated; its token never enters connector storage or client responses. */
export class LocalDriveProvider implements ConnectorProvider {
  constructor(private readonly fetchImpl: typeof fetch = fetch, private readonly timeoutMs = 15_000) {}

  async createConnectionSession(): Promise<never> {
    throw new Error("Local Drive uses the deployment token and does not require an account connection.");
  }

  async completeConnection(): Promise<never> {
    throw new Error("Local Drive uses the deployment token and does not use an OAuth callback.");
  }

  private client(token: string): McpClient {
    return new McpClient(LOCAL_DRIVE_MCP_ENDPOINT, { token }, this.fetchImpl, { timeoutMs: this.timeoutMs });
  }

  async listTools(context: ConnectorProviderContext) {
    const token = configuredToken();
    try {
      const client = this.client(token);
      await client.initialize(context.signal);
      return discoveredMcpTools(LOCAL_DRIVE_CONNECTOR_ID, LOCAL_DRIVE_VERSION, await client.listTools(context.signal)).map((tool) => ({
        ...tool,
        description: localDriveToolDescription(tool.name, tool.description),
        access: classifyLocalDriveToolAccess(tool.name, tool.description),
      }));
    } catch (error) {
      throw new Error(redactConnectorError(error, [token]));
    }
  }

  async callTool(context: ConnectorProviderContext & { tool: { name: string }; arguments: Record<string, unknown> }) {
    const token = configuredToken();
    try {
      const client = this.client(token);
      await client.initialize(context.signal);
      return normalizeMcpResult(await client.callTool(context.tool.name, context.arguments, context.signal), [token]);
    } catch (error) {
      throw new Error(redactConnectorError(error, [token]));
    }
  }

  async disconnect(): Promise<void> {}
}
