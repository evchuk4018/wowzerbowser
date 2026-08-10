import "server-only";

import type { ConnectorProvider, ConnectorProviderContext, ConnectorToolResult } from "../connector-types";
import { redactConnectorError } from "../connector-redaction";
import { McpClient } from "../mcp/mcp-client";
import { discoveredMcpTools, classifyConnectorToolAccess } from "../mcp/mcp-tool-discovery";
import { normalizeMcpResult } from "../mcp/mcp-result-normalizer";
import { workspacePath } from "../../../../lib/workspace-protocol";

export const LOCAL_DRIVE_CONNECTOR_ID = "local_drive";
export const LOCAL_DRIVE_MCP_ENDPOINT = "https://homelab.tail861ffd.ts.net/drive/mcp";
export const LOCAL_DRIVE_HEALTH_ENDPOINT = "https://homelab.tail861ffd.ts.net/drive/api/health";
export const LOCAL_DRIVE_VERSION = "1.2.0";
export const LOCAL_DRIVE_WORKSPACE_DOWNLOAD_TOOL_NAME = "drive_download_to_workspace";
export const LOCAL_DRIVE_WORKSPACE_DOWNLOAD_MAX_BYTES = 1024 * 1024 * 1024;

const LOCAL_DRIVE_TOOL_DESCRIPTIONS: Record<string, string> = {
  drive_list: "List files and folders in a Local Drive folder.",
  drive_search: "Search Local Drive files and folders by name or content.",
  drive_get_metadata: "Read metadata for a Local Drive file or folder.",
  drive_read_text: "Read the text content of a Local Drive file.",
  [LOCAL_DRIVE_WORKSPACE_DOWNLOAD_TOOL_NAME]: "Download a Local Drive file into the persistent conversation workspace (up to 1 GiB); MP4 files are rejected.",
  drive_write_file: "Write or replace a text file in Local Drive.",
  drive_create_folder: "Create a folder in Local Drive.",
  drive_rename_item: "Rename a Local Drive file or folder.",
  drive_move_item: "Move a Local Drive file or folder to another folder.",
  drive_trash_item: "Move a Local Drive file or folder to trash.",
  drive_restore_item: "Restore a Local Drive file or folder from trash.",
  drive_delete_permanently: "Permanently delete a Local Drive file or folder.",
};

const LOCAL_DRIVE_READ_TOOLS = new Set(["drive_list", "drive_search", "drive_get_metadata", "drive_read_text", LOCAL_DRIVE_WORKSPACE_DOWNLOAD_TOOL_NAME]);
const LOCAL_DRIVE_WRITE_TOOLS = new Set(["drive_write_file", "drive_create_folder", "drive_rename_item", "drive_move_item"]);
const LOCAL_DRIVE_DESTRUCTIVE_TOOLS = new Set(["drive_trash_item", "drive_restore_item", "drive_delete_permanently"]);

const WORKSPACE_DOWNLOAD_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "path"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 128, description: "Local Drive file id." },
    path: { type: "string", minLength: 1, maxLength: 512, description: "Safe relative destination path in the conversation workspace." },
    overwrite: { type: "boolean", default: false },
    expectedSha256: { type: "string", pattern: "^[0-9a-fA-F]{64}$" },
  },
} as const;

export function classifyLocalDriveToolAccess(name: string, description: string): "read" | "write" | "destructive" {
  if (LOCAL_DRIVE_READ_TOOLS.has(name)) return "read";
  if (LOCAL_DRIVE_WRITE_TOOLS.has(name)) return "write";
  if (LOCAL_DRIVE_DESTRUCTIVE_TOOLS.has(name)) return "destructive";
  return classifyConnectorToolAccess(name, description);
}

/** Local Drive is private; only explicit replacement of an existing file asks. */
export function localDriveToolRequiresApproval(name: string, argumentsValue: Record<string, unknown>): boolean {
  if (name === LOCAL_DRIVE_WORKSPACE_DOWNLOAD_TOOL_NAME) return argumentsValue.overwrite === true;
  if (name === "drive_write_file") return typeof argumentsValue.overwrite_id === "string" && Boolean(argumentsValue.overwrite_id.trim());
  return false;
}

export function localDriveToolDescription(name: string, description?: string): string {
  return LOCAL_DRIVE_TOOL_DESCRIPTIONS[name] ?? description?.trim().slice(0, 2_000) ?? `Local Drive action ${name}.`;
}

function configuredToken(): string {
  const token = process.env.LOCAL_DRIVE_API_TOKEN?.trim();
  if (!token) throw new Error("Local Drive is not configured.");
  return token;
}

function requiredString(input: Record<string, unknown>, field: string, maxLength = 512): string {
  const value = input[field];
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) throw new Error(`${field} is invalid.`);
  return value.trim();
}

function optionalExpectedSha256(input: Record<string, unknown>): string | undefined {
  const value = input.expectedSha256;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/iu.test(value)) throw new Error("expectedSha256 is invalid.");
  return value.toLowerCase();
}

function downloadUrl(id: string): string {
  const endpoint = new URL(LOCAL_DRIVE_MCP_ENDPOINT);
  const basePath = endpoint.pathname.replace(/\/mcp\/?$/u, "").replace(/\/$/u, "");
  return new URL(`${basePath}/api/drive/items/${encodeURIComponent(id)}/download`, endpoint.origin).toString();
}

function isMp4(name: string, contentType: string): boolean {
  return /\.mp4$/iu.test(name) || /^(?:video\/mp4|application\/mp4)(?:;|$)/iu.test(contentType.trim());
}

function fileMetadata(value: unknown): { id: string; name: string; sizeBytes: number; contentType: string; sha256?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Local Drive returned invalid file metadata.");
  const item = value as Record<string, unknown>;
  const id = typeof item.id === "string" ? item.id : "";
  const name = typeof item.name === "string" ? item.name : "";
  const sizeBytes = item.sizeBytes;
  const contentType = typeof item.contentType === "string" ? item.contentType : "application/octet-stream";
  if (item.kind !== "file" || !id || !name || typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new Error("Local Drive item is not a valid file.");
  }
  if (item.trashedAt !== null && item.trashedAt !== undefined) throw new Error("Trashed Local Drive files cannot be downloaded.");
  if (isMp4(name, contentType)) throw new Error("MP4 files cannot be downloaded into the workspace.");
  if (sizeBytes > LOCAL_DRIVE_WORKSPACE_DOWNLOAD_MAX_BYTES) throw new Error("Local Drive files larger than 1 GiB cannot be downloaded into the workspace.");
  return { id, name, sizeBytes, contentType, ...(typeof item.sha256 === "string" ? { sha256: item.sha256 } : {}) };
}

async function downloadIntoWorkspace(
  context: ConnectorProviderContext & { arguments: Record<string, unknown> },
  token: string,
  client: McpClient,
  fetchImpl: typeof fetch,
): Promise<ConnectorToolResult> {
  if (!context.workspace) throw new Error("A conversation workspace is required for Local Drive downloads.");
  const id = requiredString(context.arguments, "id", 128);
  const path = workspacePath(requiredString(context.arguments, "path"));
  if (!path) throw new Error("path must identify a workspace file.");
  const overwrite = context.arguments.overwrite === undefined ? false : context.arguments.overwrite;
  if (typeof overwrite !== "boolean") throw new Error("overwrite is invalid.");
  const expectedSha256 = optionalExpectedSha256(context.arguments);

  const metadataResult = normalizeMcpResult(await client.callTool("drive_get_metadata", { id }, context.signal), [token]);
  if (!metadataResult.ok) throw new Error(metadataResult.error ?? "Local Drive metadata lookup failed.");
  const metadata = fileMetadata(metadataResult.output);
  const response = await fetchImpl(downloadUrl(metadata.id), { method: "GET", headers: { authorization: `Bearer ${token}`, accept: "application/octet-stream" }, redirect: "manual", signal: context.signal });
  if (!response.ok) throw new Error(`Local Drive download failed (${response.status}).`);
  const responseType = response.headers.get("content-type") ?? metadata.contentType;
  if (isMp4(metadata.name, responseType)) throw new Error("MP4 files cannot be downloaded into the workspace.");
  const responseLength = response.headers.get("content-length");
  if (responseLength !== null) {
    const parsedLength = Number(responseLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength !== metadata.sizeBytes) throw new Error("Local Drive download size did not match its metadata.");
    if (parsedLength > LOCAL_DRIVE_WORKSPACE_DOWNLOAD_MAX_BYTES) throw new Error("Local Drive files larger than 1 GiB cannot be downloaded into the workspace.");
  }
  const source = response.body ?? new ReadableStream<Uint8Array>({ start(controller) { if (metadata.sizeBytes === 0) controller.close(); else controller.error(new Error("Local Drive returned no download body.")); } });
  const stored = await context.workspace.writeStream(path, source, metadata.sizeBytes, { overwrite, ...(expectedSha256 ? { expectedSha256 } : {}) });
  return {
    ok: true,
    output: {
      source: { id: metadata.id, name: metadata.name, size: metadata.sizeBytes, contentType: metadata.contentType, ...(metadata.sha256 ? { sha256: metadata.sha256 } : {}) },
      workspace: { path, size: stored.size, sha256: stored.sha256 },
    },
  };
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
      const discovered = await client.listTools(context.signal);
      if (!discovered.some((tool) => tool.name === LOCAL_DRIVE_WORKSPACE_DOWNLOAD_TOOL_NAME)) discovered.push({ name: LOCAL_DRIVE_WORKSPACE_DOWNLOAD_TOOL_NAME, description: LOCAL_DRIVE_TOOL_DESCRIPTIONS[LOCAL_DRIVE_WORKSPACE_DOWNLOAD_TOOL_NAME], inputSchema: WORKSPACE_DOWNLOAD_INPUT_SCHEMA });
      return discoveredMcpTools(LOCAL_DRIVE_CONNECTOR_ID, LOCAL_DRIVE_VERSION, discovered).map((tool) => ({
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
      if (context.tool.name === LOCAL_DRIVE_WORKSPACE_DOWNLOAD_TOOL_NAME) {
        return await downloadIntoWorkspace(context, token, client, this.fetchImpl);
      }
      return normalizeMcpResult(await client.callTool(context.tool.name, context.arguments, context.signal), [token]);
    } catch (error) {
      throw new Error(redactConnectorError(error, [token]));
    }
  }

  async disconnect(): Promise<void> {}
}
