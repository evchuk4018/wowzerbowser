import "server-only";

import type { ConnectorProvider, ConnectorProviderContext, ConnectionSession } from "../connector-types";
import type { ConnectorTool, ConnectorToolResult } from "../../../../lib/connector-protocol";
import { googleGmailAuthorizationUrl, exchangeGoogleGmailCode, refreshGoogleGmailAccessToken } from "./google-gmail-oauth";
import { gmailBatchRead, gmailProfile, gmailReadThread, gmailSearch } from "./google-gmail-adapter";

const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ConnectorTool => ({ connectorId: "gmail", name, namespacedName: "", description, inputSchema: { type: "object", additionalProperties: false, properties, ...(required.length ? { required } : {}) }, access: "read", enabled: true, connectorVersion: "1.0.0", discoveredAt: new Date().toISOString() });

const TOOLS = [
  tool("search_emails", "Search Gmail messages and return message-level summaries.", { query: { type: "string", minLength: 1, maxLength: 500 }, maxResults: { type: "integer", minimum: 1, maximum: 100 }, pageToken: { type: "string" }, includeSpamTrash: { type: "boolean" }, tags: { type: "array", maxItems: 20, items: { type: "string", pattern: "^[A-Z0-9_-]+$" } } }, ["query"]),
  tool("search_email_ids", "Search Gmail and return only matching message IDs for a later read.", { query: { type: "string", minLength: 1, maxLength: 500 }, maxResults: { type: "integer", minimum: 1, maximum: 100 }, pageToken: { type: "string" }, includeSpamTrash: { type: "boolean" }, tags: { type: "array", maxItems: 20, items: { type: "string", pattern: "^[A-Z0-9_-]+$" } } }, ["query"]),
  tool("read_email_thread", "Read a Gmail conversation by message or thread ID.", { id: { type: "string", minLength: 1 }, id_type: { type: "string", enum: ["message", "thread"] } }, ["id"]),
  tool("batch_read_email", "Read several Gmail messages by ID, including their bodies and attachment metadata.", { message_ids: { type: "array", minItems: 1, maxItems: 25, items: { type: "string", minLength: 1 } } }, ["message_ids"]),
];

export class GoogleGmailProvider implements ConnectorProvider {
  async createConnectionSession(context: ConnectorProviderContext): Promise<ConnectionSession> {
    const state = typeof context.metadata?.state === "string" ? context.metadata.state : "";
    if (!state) throw new Error("Gmail OAuth state is missing.");
    return { authorizationUrl: googleGmailAuthorizationUrl(state), state };
  }

  async completeConnection(context: ConnectorProviderContext & { code: string; state: string }) {
    const token = await exchangeGoogleGmailCode(context.code);
    const accessToken = await refreshGoogleGmailAccessToken(token.refreshToken);
    const profile = await gmailProfile(accessToken);
    return { accountLabel: profile.emailAddress ?? undefined, accountEmail: profile.emailAddress ?? undefined, credentials: { refresh_token: token.refreshToken }, metadata: { scope: token.scope } };
  }

  async listTools(): Promise<ConnectorTool[]> { return TOOLS.map((item) => ({ ...item, discoveredAt: new Date().toISOString() })); }

  async callTool(context: ConnectorProviderContext & { tool: ConnectorTool; arguments: Record<string, unknown> }): Promise<ConnectorToolResult> {
    const refreshToken = context.credentials?.refresh_token;
    if (typeof refreshToken !== "string" || !refreshToken) return { ok: false, error: "Gmail must be reconnected.", isError: true };
    const accessToken = await refreshGoogleGmailAccessToken(refreshToken);
    const input = context.arguments;
    switch (context.tool.name) {
      case "search_emails": return { ok: true, output: await gmailSearch(accessToken, input as Parameters<typeof gmailSearch>[1]) };
      case "search_email_ids": { const result = await gmailSearch(accessToken, input as Parameters<typeof gmailSearch>[1]); return { ok: true, output: { ids: result.messages.map((message) => message.id), nextPageToken: result.nextPageToken, resultSizeEstimate: result.resultSizeEstimate } }; }
      case "read_email_thread": return { ok: true, output: await gmailReadThread(accessToken, String(input.id), input.id_type === "thread" ? "thread" : "message") };
      case "batch_read_email": return { ok: true, output: await gmailBatchRead(accessToken, Array.isArray(input.message_ids) ? input.message_ids.map(String) : []) };
      default: return { ok: false, error: "Unknown Gmail read tool.", isError: true };
    }
  }

  async disconnect(): Promise<void> {}
}
