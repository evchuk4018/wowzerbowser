import "server-only";

const SECRET_KEY = /authorization|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password|secret|credential/i;

export function redactConnectorValue(value: unknown, depth = 0, secrets: readonly string[] = []): unknown {
  if (depth > 5) return "[redacted]";
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactConnectorValue(item, depth + 1, secrets));
  if (!value || typeof value !== "object") {
    if (typeof value !== "string") return value;
    const secret = secrets.filter((item) => item.length >= 8).sort((left, right) => right.length - left.length).reduce((result, item) => result.split(item).join("[redacted]"), value);
    return /bearer\s+[A-Za-z0-9._~+/-]{8,}/i.test(secret) ? "[redacted]" : secret;
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 100).map(([name, item]) => [name, SECRET_KEY.test(name) ? "[redacted]" : redactConnectorValue(item, depth + 1, secrets)]));
}

export function redactConnectorError(error: unknown, secrets: readonly string[] = []): string {
  const message = error instanceof Error ? error.message : String(error);
  const secretRedacted = secrets.filter((item) => item.length >= 8).sort((left, right) => right.length - left.length).reduce((result, item) => result.split(item).join("[redacted]"), message);
  return secretRedacted
    .replace(/bearer\s+[A-Za-z0-9._~+/-]{8,}/gi, "Bearer [redacted]")
    .replace(/(authorization|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .slice(0, 500);
}
