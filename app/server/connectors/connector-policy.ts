import "server-only";

import type { ConnectorAccess, ConnectorManifest } from "../../../lib/connector-protocol";
import { getPermission } from "./connector-repository";
import { localDriveToolRequiresApproval } from "./providers/local-drive-provider";

export async function requiresConnectorApproval(ownerId: string, manifest: ConnectorManifest, toolName: string, access: ConnectorAccess, argumentsValue: Record<string, unknown> = {}): Promise<boolean> {
  if (manifest.provider === "local_drive") return localDriveToolRequiresApproval(toolName, argumentsValue);
  if (access === "destructive") return true;
  const permission = await getPermission(ownerId, manifest.id, toolName);
  if (permission && permission.enabled === false) return false;
  if (permission?.approval_mode === "never") return false;
  return manifest.defaultApproval[access] === "always";
}
