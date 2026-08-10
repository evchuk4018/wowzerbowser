import "server-only";

import type { ConnectorToolResult } from "../connector-types";
import { redactConnectorError, redactConnectorValue } from "../connector-redaction";

export function normalizeMcpResult(value: unknown, secrets: readonly string[] = []): ConnectorToolResult {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const item = value as Record<string, unknown>;
    const isError = item.isError === true;
    return { ok: !isError, output: redactConnectorValue(item.structuredContent ?? item.content ?? value, 0, secrets), ...(isError ? { error: redactConnectorError(item.error ?? "MCP tool returned an error.", secrets), isError: true } : {}) };
  }
  return { ok: true, output: redactConnectorValue(value, 0, secrets) };
}
