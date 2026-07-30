import "server-only";

import type { ConnectorToolResult } from "../connector-types";
import { redactConnectorError, redactConnectorValue } from "../connector-redaction";

export function normalizeMcpResult(value: unknown): ConnectorToolResult {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const item = value as Record<string, unknown>;
    const isError = item.isError === true;
    return { ok: !isError, output: redactConnectorValue(item.structuredContent ?? item.content ?? value), ...(isError ? { error: redactConnectorError(item.error ?? "MCP tool returned an error."), isError: true } : {}) };
  }
  return { ok: true, output: redactConnectorValue(value) };
}
