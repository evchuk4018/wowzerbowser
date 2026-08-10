import "server-only";

import { randomUUID } from "node:crypto";
import { redactConnectorError } from "../connector-redaction";

type JsonRpcResponse = { id?: string; result?: Record<string, unknown>; error?: { message?: string } };

export type McpClientErrorKind = "authentication" | "authorization" | "connectivity" | "server" | "timeout" | "protocol";

export class McpClientError extends Error {
  constructor(readonly kind: McpClientErrorKind, message: string, readonly status?: number) {
    super(message);
    this.name = "McpClientError";
  }
}

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

  constructor(
    private readonly endpoint: string,
    private readonly credentials?: Record<string, unknown>,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly options: { timeoutMs?: number } = {},
  ) {
    assertSafeMcpUrl(endpoint);
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { accept: "application/json, text/event-stream", "content-type": "application/json" };
    const authorization = authHeader(this.credentials);
    if (authorization) headers.authorization = authorization;
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    return headers;
  }

  private async send(method: string, params: Record<string, unknown>, signal?: AbortSignal, notification = false): Promise<Response> {
    const id = `${randomUUID()}-${++this.requestId}`;
    const timeoutMs = Math.max(1, this.options.timeoutMs ?? 15_000);
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
    let response: Response;
    try {
      const body = notification ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params };
      response = await this.fetchImpl(this.endpoint, { method: "POST", headers: this.headers(), redirect: "manual", body: JSON.stringify(body), signal: requestSignal });
    } catch (error) {
      if (timeoutController.signal.aborted) throw new McpClientError("timeout", "MCP server request timed out.");
      if (signal?.aborted) throw error;
      throw new McpClientError("connectivity", "Could not connect to the MCP server.");
    } finally {
      clearTimeout(timeout);
    }
    if (response.status >= 300 && response.status < 400) throw new McpClientError("protocol", "MCP server returned an unsafe redirect.", response.status);
    if (!response.ok) {
      const kind: McpClientErrorKind = response.status === 401
        ? "authentication"
        : response.status === 403
          ? "authorization"
          : response.status === 408 || response.status === 504
            ? "timeout"
            : response.status >= 500
              ? "server"
              : "protocol";
      const message = kind === "authentication"
        ? "MCP server authentication failed (401)."
        : kind === "authorization"
          ? "MCP server authorization was denied (403)."
          : kind === "timeout"
            ? `MCP server request timed out (${response.status}).`
            : kind === "server"
              ? `MCP server returned a server error (${response.status}).`
              : `MCP server request failed (${response.status}).`;
      throw new McpClientError(kind, redactConnectorError(message), response.status);
    }
    const session = response.headers.get("mcp-session-id");
    if (session) this.sessionId = session;
    return response;
  }

  private async request(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const response = await this.send(method, params, signal);
    const contentType = response.headers.get("content-type") ?? "";
    let value: JsonRpcResponse;
    try {
      value = contentType.includes("text/event-stream") ? await this.readSse(response) : await response.json() as JsonRpcResponse;
    } catch (error) {
      if (error instanceof McpClientError) throw error;
      throw new McpClientError("protocol", "MCP server returned an invalid response.");
    }
    if (value.error) throw new McpClientError("protocol", redactConnectorError(value.error.message ?? "MCP request failed."));
    if (!value.result) throw new McpClientError("protocol", "MCP server returned no result.");
    return value.result;
  }

  private async readSse(response: Response): Promise<JsonRpcResponse> {
    const text = await response.text();
    const data = text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter(Boolean).at(-1);
    if (!data) throw new McpClientError("protocol", "MCP server returned an empty event stream.");
    try {
      return JSON.parse(data) as JsonRpcResponse;
    } catch {
      throw new McpClientError("protocol", "MCP server returned an invalid event stream.");
    }
  }

  async initialize(signal?: AbortSignal): Promise<void> {
    await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "wowzerbowser", version: "1.0.0" } }, signal);
    await this.notify("notifications/initialized", signal);
  }

  private async notify(method: string, signal?: AbortSignal): Promise<void> {
    await this.send(method, {}, signal, true);
  }

  async listTools(signal?: AbortSignal): Promise<Array<{name: string; description?: string; inputSchema?: Record<string, unknown>}>> {
    const result = await this.request("tools/list", {}, signal);
    return Array.isArray(result.tools) ? result.tools.filter((tool): tool is {name: string; description?: string; inputSchema?: Record<string, unknown>} => Boolean(tool && typeof tool === "object" && typeof (tool as Record<string, unknown>).name === "string")) : [];
  }

  async callTool(name: string, argumentsValue: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return this.request("tools/call", { name, arguments: argumentsValue }, signal);
  }
}
