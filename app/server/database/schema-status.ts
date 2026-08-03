import "server-only";

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { query } from "./database";

export type DatabaseSchemaStatus = {
  current: boolean;
  expectedVersion: string | null;
  appliedVersions: string[];
  pendingVersions: string[];
  unknownVersions: string[];
  changedVersions: string[];
};

type MigrationFile = { version: string; checksum: string };

async function migrationFiles(): Promise<MigrationFile[]> {
  const directory = path.join(process.cwd(), "database", "migrations");
  const entries = await readdir(directory, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
  return await Promise.all(files.map(async (name) => ({
    version: name.slice(0, -4),
    checksum: createHash("sha256").update(await readFile(path.join(directory, name))).digest("hex"),
  })));
}

export async function readDatabaseSchemaStatus(): Promise<DatabaseSchemaStatus> {
  const files = await migrationFiles();
  const expected = new Map(files.map((file) => [file.version, file.checksum]));
  const rows = await query<{ version: string; checksum: string | null }>(
    "select version, checksum from public.schema_migrations order by version",
  );
  const appliedVersions = rows.map((row) => String(row.version));
  const pendingVersions = files.filter((file) => !appliedVersions.includes(file.version)).map((file) => file.version);
  const unknownVersions = appliedVersions.filter((version) => !expected.has(version));
  const changedVersions = rows
    .filter((row) => row.checksum && expected.get(String(row.version)) !== row.checksum)
    .map((row) => String(row.version));
  return {
    current: pendingVersions.length === 0 && unknownVersions.length === 0 && changedVersions.length === 0,
    expectedVersion: files.at(-1)?.version ?? null,
    appliedVersions,
    pendingVersions,
    unknownVersions,
    changedVersions,
  };
}

export function assertDatabaseSchemaStatus(status: DatabaseSchemaStatus): void {
  if (status.unknownVersions.length) throw new Error(`Database contains unknown migrations: ${status.unknownVersions.join(", ")}.`);
  if (status.changedVersions.length) throw new Error(`Applied migrations changed on disk: ${status.changedVersions.join(", ")}.`);
  if (status.pendingVersions.length) throw new Error(`Local PostgreSQL migrations are missing: ${status.pendingVersions.join(", ")}.`);
}
