import "server-only";

import { logCall } from "./connector-repository";
import { redactConnectorError, redactConnectorValue } from "./connector-redaction";

export async function auditConnectorCall(values: { ownerId: string; connectorId: string; connectionId: string; toolName: string; access: string; arguments: Record<string, unknown>; ok: boolean; error?: unknown; durationMs: number }): Promise<void> {
  await logCall({ ownerId: values.ownerId, connectorId: values.connectorId, connectionId: values.connectionId, toolName: values.toolName, access: values.access, arguments: redactConnectorValue(values.arguments) as Record<string, unknown>, ok: values.ok, errorCode: values.error ? redactConnectorError(values.error) : undefined, durationMs: values.durationMs }).catch(() => undefined);
}
