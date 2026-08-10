import "server-only";

import type { ConnectorManifest } from "../../../lib/connector-protocol";

export const MANAGED_CONNECTOR_MANIFESTS: ConnectorManifest[] = [
  {
    id: "gmail", name: "Gmail", description: "Search and read messages from a connected Gmail account.", version: "1.0.0", provider: "google_gmail", auth: { type: "oauth2" },
    capabilities: ["search", "read"], defaultApproval: { read: "never", write: "always", destructive: "always" },
  },
  {
    id: "outlook", name: "Outlook", description: "Search and read messages from a connected Outlook account.", version: "1.0.0", provider: "microsoft_outlook", auth: { type: "oauth2" },
    capabilities: ["search", "read"], defaultApproval: { read: "never", write: "always", destructive: "always" },
  },
  {
    id: "google_drive", name: "Google Drive", description: "Find and read files from a connected Google Drive account.", version: "1.0.0", provider: "managed", auth: { type: "oauth2" },
    capabilities: ["search", "read", "write"], defaultApproval: { read: "never", write: "always", destructive: "always" },
  },
  {
    id: "notion", name: "Notion", description: "Search and work with pages in a connected Notion workspace.", version: "1.0.0", provider: "managed", auth: { type: "oauth2" },
    capabilities: ["search", "read", "write"], defaultApproval: { read: "never", write: "always", destructive: "always" },
  },
  {
    id: "slack", name: "Slack", description: "Search conversations and interact with a connected Slack workspace.", version: "1.0.0", provider: "managed", auth: { type: "oauth2" },
    capabilities: ["search", "read", "write", "destructive"], defaultApproval: { read: "never", write: "always", destructive: "always" },
  },
  {
    id: "local_drive", name: "Local Drive", description: "Search, read, manage, and import files from the private Local Drive service.", version: "1.2.0", provider: "local_drive", auth: { type: "none" },
    capabilities: ["search", "read", "write", "destructive"], defaultApproval: { read: "never", write: "never", destructive: "never" },
  },
];

export function normalizeConnectorId(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 64);
}

export function namespaceConnectorTool(connectorId: string, toolName: string): string {
  return `connector__${normalizeConnectorId(connectorId)}__${normalizeConnectorId(toolName)}`;
}

export function managedConnectorManifest(connectorId: string): ConnectorManifest | undefined {
  return MANAGED_CONNECTOR_MANIFESTS.find((item) => item.id === connectorId);
}

export function connectorManifest(id: string, custom?: ConnectorManifest): ConnectorManifest | undefined {
  return custom ?? managedConnectorManifest(id);
}
