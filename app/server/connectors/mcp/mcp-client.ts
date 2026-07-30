import "server-only";

import { randomUUID } from "node:crypto";
import { redactConnectorError } from "../connector-redaction";

type JsonRpcResponse = { id?: string; result?: Record<string, unknown>; error?: { message?: string } };

export function assertSafeMcpUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("Remote MCP servers must use HTTPS.");
  const hostname = url.hostname.toLocaleLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".local") || hostname === "::1" || hostname === "0.0.0.0" || hostname === "127.0.0.1" || hostname.startsWith("10.") || hostname.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname) || hostname.startsWith("169.254.")) throw new Error("That MCP address points to a private or local network.");
  return url.toString();
}

function authHeader(credentials: Record<string, unknown> | undefined): string | undefined {
  const token = credentials?.token;
  return typeof token === "string" && token ? `Bearer ${token}` : undefined;
}

export class McpClient {
  private sessionId: string | undefined;
  private requestId = 0;

  constructor(private readonly endpoint: string, private readonly credentials?: Record<string, unknown>, private readonly fetchImpl: typeof fetch = fetch) {
    assertSafeMcpUrl(endpoint);
  }

  private async request(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = `${randomUUID()}-${++this.requestId}`;
    const headers: Record<string, string> = { accept: "application/json, text/event-stream", "content-type": "application/json" };
    const authorization = authHeader(this.credentials);
    if (authorization) headers.authorization = authorization;
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    const response = await this.fetchImpl(this.endpoint, { method: "POST", headers, redirect: "manual", body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
    if (response.status >= 300 && response.status < 400) throw new Error("MCP server returned an unsafe redirect.");
    if (!response.ok) throw new Error(redactConnectorError(`MCP server request failed (${response.status}).`));
    const session = response.headers.get("mcp-session-id");
    if (session) this.sessionId = session;
    const contentType = response.headers.get("content-type") ?? "";
    const value = contentType.includes("text/event-stream") ? await this.readSse(response) : await response.json() as JsonRpcResponse;
    if (value.error) throw new Error(redactConnectorError(value.error.message ?? "MCP request failed."));
    if (!value.result) throw new Error("MCP server returned no result.");
    return value.result;
  }

  private async readSse(response: Response): Promise<JsonRpcResponse> {
    const text = await response.text();
    const data = text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter(Boolean).at(-1);
    if (!data) throw new Error("MCP server returned an empty event stream.");
    return JSON.parse(data) as JsonRpcResponse;
  }

  async initialize(): Promise<void> {
    await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "wowzerbowser", version: "1.0.0" } });
    await this.notify("notifications/initialized");
  }

  private async notify(method: string): Promise<void> {
    const headers: Record<string, string> = { accept: "application/json, text/event-stream", "content-type": "application/json" };
    const authorization = authHeader(this.credentials);
    if (authorization) headers.authorization = authorization;
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    await this.fetchImpl(this.endpoint, { method: "POST", headers, redirect: "manual", body: JSON.stringify({ jsonrpc: "2.0", method }) });
  }

  async listTools(): Promise<Array<{name: string; description?: string; inputSchema?: Record<string, unknown>}>> {
    const result = await this.request("tools/list");
    return Array.isArray(result.tools) ? result.tools.filter((tool): tool is {name: string; description?: string; inputSchema?: Record<string, unknown>} => Boolean(tool && typeof tool === "object" && typeof (tool as Record<string, unknown>).name === "string")) : [];
  }

  async callTool(name: string, argumentsValue: Record<string, unknown>): Promise<unknown> {
    return this.request("tools/call", { name, arguments: argumentsValue });
  }
}
