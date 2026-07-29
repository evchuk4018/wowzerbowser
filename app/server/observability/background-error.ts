const MAX_ERROR_TEXT_LENGTH = 240;

export type BackgroundErrorDetails = {
  message: string;
  code?: string;
  details?: string;
  hint?: string;
};

type ErrorRecord = Record<string, unknown>;

function redact(value: string): string {
  return value
    .replace(/\bsk-[a-z0-9_-]+\b/gi, "[redacted]")
    .replace(/\bbearer\s+[a-z0-9._-]+\b/gi, "Bearer [redacted]")
    .replace(/\b(password|api[_ -]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .slice(0, MAX_ERROR_TEXT_LENGTH);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? redact(value.trim()) : undefined;
}

function recordOf(error: unknown): ErrorRecord | null {
  return error && typeof error === "object" ? error as ErrorRecord : null;
}

export function describeBackgroundError(error: unknown): BackgroundErrorDetails {
  const record = recordOf(error);
  const message = text(error instanceof Error ? error.message : record?.message)
    ?? (typeof error === "string" ? redact(error) : "Unknown background task failure.");
  const code = text(record?.code) ?? (error instanceof Error ? text(record?.name) : undefined);
  const details = text(record?.details);
  const hint = text(record?.hint);
  return {
    message,
    ...(code ? { code } : {}),
    ...(details ? { details } : {}),
    ...(hint ? { hint } : {}),
  };
}

export function formatBackgroundError(error: unknown): string {
  const details = describeBackgroundError(error);
  return [
    details.code ? `[${details.code}]` : "",
    details.message,
    details.details ? `details: ${details.details}` : "",
    details.hint ? `hint: ${details.hint}` : "",
  ].filter(Boolean).join(" ").slice(0, MAX_ERROR_TEXT_LENGTH);
}

export function logBackgroundTaskFailure(
  event: string,
  context: Record<string, string | number | boolean | null | undefined>,
  error: unknown,
): BackgroundErrorDetails {
  const details = describeBackgroundError(error);
  console.warn({
    event,
    ...context,
    errorCode: details.code ?? "UnknownError",
    errorMessage: details.message,
    ...(details.details ? { errorDetails: details.details } : {}),
    ...(details.hint ? { errorHint: details.hint } : {}),
  });
  return details;
}
