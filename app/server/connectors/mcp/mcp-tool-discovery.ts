import "server-only";

import type { ConnectorAccess, ConnectorTool } from "../../../../lib/connector-protocol";
import { namespaceConnectorTool } from "../connector-registry";

export function classifyConnectorToolAccess(name: string, description: string): ConnectorAccess {
  const text = `${name} ${description}`.toLocaleLowerCase();
  if (/delete|remove|cancel|publish|pay|destroy|revoke|archive|trash|restore/.test(text)) return "destructive";
  if (/create|write|update|edit|send|post|move|rename|upload|insert|add/.test(text)) return "write";
  return "read";
}

export function discoveredMcpTools(connectorId: string, version: string, tools: Array<{name: string; description?: string; inputSchema?: Record<string, unknown>}>): ConnectorTool[] {
  return tools.map((tool) => ({ connectorId, name: tool.name, namespacedName: namespaceConnectorTool(connectorId, tool.name), description: tool.description?.slice(0, 2_000) || `Remote MCP action ${tool.name}.`, inputSchema: tool.inputSchema ?? { type: "object", additionalProperties: true }, access: classifyConnectorToolAccess(tool.name, tool.description ?? ""), enabled: true, connectorVersion: version, discoveredAt: new Date().toISOString() }));
}
