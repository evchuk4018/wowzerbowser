import "server-only";

import { databaseOwnerId, jsonb, query } from "../database/database";

type RuntimeConfigRow = {
  values: unknown;
  updated_at: unknown;
};

export async function readRuntimeConfigOverrides(ownerId: string): Promise<{ values: Record<string, unknown>; updatedAt: string | null }> {
  const [row] = await query<RuntimeConfigRow>(
    "select values, updated_at from runtime_configurations where owner_id = $1",
    [databaseOwnerId(ownerId)],
  );
  const values = row?.values && typeof row.values === "object" && !Array.isArray(row.values)
    ? row.values as Record<string, unknown>
    : {};
  return {
    values,
    updatedAt: row?.updated_at ? new Date(String(row.updated_at)).toISOString() : null,
  };
}

export async function saveRuntimeConfigOverrides(ownerId: string, values: Record<string, unknown>): Promise<string> {
  const updatedAt = new Date().toISOString();
  await query(
    `insert into runtime_configurations (owner_id, values, updated_at)
     values ($1, $2::jsonb, $3)
     on conflict (owner_id) do update set values = excluded.values, updated_at = excluded.updated_at`,
    [databaseOwnerId(ownerId), jsonb(values), updatedAt],
  );
  return updatedAt;
}
