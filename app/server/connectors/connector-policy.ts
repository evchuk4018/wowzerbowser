import "server-only";

import type { ConnectorAccess, ConnectorManifest } from "../../../lib/connector-protocol";
import { getPermission } from "./connector-repository";

export async function requiresConnectorApproval(ownerId: string, manifest: ConnectorManifest, toolName: string, access: ConnectorAccess): Promise<boolean> {
  if (access === "destructive") return true;
  const permission = await getPermission(ownerId, manifest.id, toolName);
  if (permission && permission.enabled === false) return false;
  if (permission?.approval_mode === "never") return false;
  return manifest.defaultApproval[access] === "always";
}
