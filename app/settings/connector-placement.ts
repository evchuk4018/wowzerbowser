import type { ConnectorCatalogItem } from "../../lib/connector-protocol";

const TOOLS_CONNECTOR_IDS = new Set(["gmail", "outlook"]);

export function isToolsConnector(connector: Pick<ConnectorCatalogItem, "id">): boolean {
  return TOOLS_CONNECTOR_IDS.has(connector.id);
}
