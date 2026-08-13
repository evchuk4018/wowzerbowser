import "server-only";

import postgres, { type Sql } from "postgres";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type DatabaseRow = Record<string, unknown>;
export type DatabaseExecutor = {
  unsafe<Row extends DatabaseRow = DatabaseRow>(statement: string, parameters?: readonly unknown[]): Promise<Row[]>;
};

type DatabaseGlobals = {
  postgresClient?: Sql;
};

const globals = globalThis as typeof globalThis & DatabaseGlobals;
const transientPostgresCodes = new Set([
  "08000", "08001", "08003", "08004", "08006", "08007", "08P01",
  "40001", "40P01", "55P03", "57P01", "57P02", "57P03", "53300",
  "53400", "57014",
]);

// Postgres.js emits the named connection errors, while socket failures can
// arrive as the native Node error codes. Keep these separate from SQLSTATEs so
// callers can decide when replacing a shared client is safe.
const databaseTransportCodes = new Set([
  "CONNECT_TIMEOUT", "CONNECTION_CLOSED", "CONNECTION_DESTROYED", "CONNECTION_ENDED",
  "EAI_AGAIN", "ECONNABORTED", "ECONNREFUSED", "ECONNRESET", "EHOSTDOWN",
  "EHOSTUNREACH", "ENETDOWN", "ENETUNREACH", "EPIPE", "ETIMEDOUT",
]);

function poolSize(): number {
  const configured = Number(process.env.POSTGRES_POOL_MAX ?? 4);
  return Number.isInteger(configured) && configured > 0 && configured <= 16 ? configured : 4;
}

export function getDatabase(): Sql {
  if (globals.postgresClient) return globals.postgresClient;

  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error("DATABASE_URL is required for local PostgreSQL access.");
  }

  globals.postgresClient = postgres(connectionString, {
    max: poolSize(),
    idle_timeout: 20,
    connect_timeout: 10,
    max_lifetime: 60 * 30,
    onnotice: () => undefined,
  });
  return globals.postgresClient;
}

export async function query<Row extends DatabaseRow = DatabaseRow>(
  statement: string,
  parameters: readonly unknown[] = [],
): Promise<Row[]> {
  return await getDatabase().unsafe<Row[]>(statement, [...parameters] as never[]) as unknown as Row[];
}

export async function execute(
  statement: string,
  parameters: readonly unknown[] = [],
): Promise<void> {
  await getDatabase().unsafe(statement, [...parameters] as never[]);
}

export async function withTransaction<T>(
  operation: (transaction: DatabaseExecutor) => Promise<T>,
): Promise<T> {
  return await getDatabase().begin(async (transaction) => operation({
    unsafe: async <Row extends DatabaseRow = DatabaseRow>(statement: string, parameters: readonly unknown[] = []) =>
      await transaction.unsafe<Row[]>(statement, [...parameters] as never[]) as unknown as Row[],
  })) as T;
}

export async function closeDatabase(): Promise<void> {
  const client = globals.postgresClient;
  globals.postgresClient = undefined;
  if (client) await client.end({ timeout: 5 });
}

/**
 * Drop a failed shared client without making cleanup part of request
 * recovery. The identity check prevents a late failure from closing a newer
 * client created by another request.
 */
export function discardDatabase(client: Sql): void {
  if (globals.postgresClient !== client) return;
  globals.postgresClient = undefined;
  try {
    void client.end({ timeout: 5 }).catch(() => undefined);
  } catch {
    // A failed transport is already being discarded; cleanup is best effort.
  }
}

export function databaseOwnerId(requestedOwnerId?: string): string {
  // The authenticated ID is deliberately not used as the database key. It
  // remains an explicit parameter so repository call sites show the owner
  // boundary and so a future multi-owner migration can change this centrally.
  void requestedOwnerId;
  const configured = process.env.APP_OWNER_ID?.trim();
  if (!configured || !UUID_PATTERN.test(configured)) {
    throw new Error("APP_OWNER_ID must be configured as a server-only UUID.");
  }
  return configured;
}

/** Mark a value as PostgreSQL jsonb so function arguments retain their shape. */
export function jsonb(value: unknown): unknown {
  return getDatabase().json(value as never);
}

export function isRetryableDatabaseError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && (transientPostgresCodes.has(code) || databaseTransportCodes.has(code));
}

export function isDatabaseTransportError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && databaseTransportCodes.has(code);
}

export function isoTimestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export function nullableIsoTimestamp(value: unknown): string | null {
  return value === null || value === undefined ? null : isoTimestamp(value);
}
