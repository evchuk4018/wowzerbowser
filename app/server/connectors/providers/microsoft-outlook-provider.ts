import "server-only";

import type { ConnectorProvider, ConnectorProviderContext, ConnectionSession } from "../connector-types";
import type { ConnectorTool, ConnectorToolResult } from "../../../../lib/connector-protocol";
import { exchangeMicrosoftOutlookCode, microsoftOutlookAuthorizationUrl, refreshMicrosoftOutlookAccessToken } from "./microsoft-outlook-oauth";
import { outlookBatchRead, outlookGetMessage, outlookProfile, outlookSearch } from "./microsoft-outlook-adapter";

const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ConnectorTool => ({ connectorId: "outlook", name, namespacedName: "", description, inputSchema: { type: "object", additionalProperties: false, properties, ...(required.length ? { required } : {}) }, access: "read", enabled: true, connectorVersion: "1.0.0", discoveredAt: new Date().toISOString() });

const TOOLS = [
  tool("search_emails", "Search Outlook messages and return message-level summaries.", { query: { type: "string", minLength: 1, maxLength: 500 }, maxResults: { type: "integer", minimum: 1, maximum: 100 }, pageToken: { type: "string", maxLength: 4_096 } }, ["query"]),
  tool("search_email_ids", "Search Outlook and return only matching message IDs for a later read.", { query: { type: "string", minLength: 1, maxLength: 500 }, maxResults: { type: "integer", minimum: 1, maximum: 100 }, pageToken: { type: "string", maxLength: 4_096 } }, ["query"]),
  tool("read_email", "Read one Outlook message, including its body and attachment metadata.", { id: { type: "string", minLength: 1 } }, ["id"]),
  tool("batch_read_email", "Read several Outlook messages by ID, including their bodies and attachment metadata.", { message_ids: { type: "array", minItems: 1, maxItems: 25, items: { type: "string", minLength: 1 } } }, ["message_ids"]),
];

export class MicrosoftOutlookProvider implements ConnectorProvider {
  async createConnectionSession(context: ConnectorProviderContext): Promise<ConnectionSession> {
    const state = typeof context.metadata?.state === "string" ? context.metadata.state : "";
    if (!state) throw new Error("Outlook OAuth state is missing.");
    return { authorizationUrl: microsoftOutlookAuthorizationUrl(state), state };
  }

  async completeConnection(context: ConnectorProviderContext & { code: string; state: string }) {
    const token = await exchangeMicrosoftOutlookCode(context.code);
    const profile = await outlookProfile(token.accessToken);
    return {
      accountLabel: profile.displayName ?? profile.emailAddress ?? undefined,
      accountEmail: profile.emailAddress ?? undefined,
      credentials: { refresh_token: token.refreshToken },
      metadata: { scope: token.scope },
    };
  }

  async listTools(): Promise<ConnectorTool[]> { return TOOLS.map((item) => ({ ...item, discoveredAt: new Date().toISOString() })); }

  async callTool(context: ConnectorProviderContext & { tool: ConnectorTool; arguments: Record<string, unknown> }): Promise<ConnectorToolResult> {
    const refreshToken = context.credentials?.refresh_token;
    if (typeof refreshToken !== "string" || !refreshToken) return { ok: false, error: "Outlook must be reconnected.", isError: true };
    const accessToken = await refreshMicrosoftOutlookAccessToken(refreshToken);
    const input = context.arguments;
    switch (context.tool.name) {
      case "search_emails": return { ok: true, output: await outlookSearch(accessToken, input as Parameters<typeof outlookSearch>[1], context.signal) };
      case "search_email_ids": {
        const result = await outlookSearch(accessToken, input as Parameters<typeof outlookSearch>[1], context.signal);
        return { ok: true, output: { ids: result.messages.map((message) => message.id), nextPageToken: result.nextPageToken, resultSizeEstimate: result.resultSizeEstimate } };
      }
      case "read_email": return { ok: true, output: await outlookGetMessage(accessToken, String(input.id), context.signal) };
      case "batch_read_email": return { ok: true, output: await outlookBatchRead(accessToken, Array.isArray(input.message_ids) ? input.message_ids.map(String) : [], context.signal) };
      default: return { ok: false, error: "Unknown Outlook read tool.", isError: true };
    }
  }

  async disconnect(): Promise<void> {}
}
