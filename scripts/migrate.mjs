import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDirectory = path.resolve(process.env.DATABASE_MIGRATIONS_DIR ?? path.join(projectRoot, "database", "migrations"));
const command = process.argv[2] ?? "apply";
const MIGRATION_LOCK_KEY = "743819264501";

function connectionString() {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) throw new Error("DATABASE_URL is required for database migrations.");
  return value;
}

async function migrationFiles() {
  const names = await readdir(migrationsDirectory, { withFileTypes: true });
  return names.filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({ name, version: name.slice(0, -4), path: path.join(migrationsDirectory, name) }));
}

async function ensureMigrationTable(sql) {
  await sql.unsafe("create table if not exists public.schema_migrations (version text primary key, applied_at timestamptz not null default now())");
}

async function main() {
  const sql = postgres(connectionString(), { max: 1, connect_timeout: 10, idle_timeout: 10, prepare: true, onnotice: () => {} });
  let migrationLockAcquired = false;
  try {
    await sql.unsafe("select pg_advisory_lock($1::bigint)", [MIGRATION_LOCK_KEY]);
    migrationLockAcquired = true;
    await ensureMigrationTable(sql);
    const files = await migrationFiles();
    const appliedRows = await sql.unsafe("select version, applied_at from public.schema_migrations order by version");
    const applied = new Map(appliedRows.map((row) => [row.version, row.applied_at]));

    if (command === "--status" || command === "status" || command === "--check" || command === "check") {
      for (const file of files) console.log(`${applied.has(file.version) ? "applied" : "pending"}\t${file.version}`);
      const pending = files.filter((file) => !applied.has(file.version));
      console.log(`migration-status\tapplied=${files.length - pending.length}\tpending=${pending.length}`);
      if (command === "--check" || command === "check") {
        if (pending.length) throw new Error(`Local PostgreSQL migrations are missing: ${pending.map((file) => file.version).join(", ")}`);
        return;
      }
      return;
    }

    if (command !== "apply" && command !== "--initialize" && command !== "initialize") {
      throw new Error(`Unknown migration command: ${command}`);
    }

    let appliedCount = 0;
    for (const file of files) {
      if (applied.has(file.version)) continue;
      const source = await readFile(file.path, "utf8");
      await sql.begin(async (transaction) => {
        await transaction.unsafe(source);
        await transaction.unsafe("insert into public.schema_migrations(version) values ($1)", [file.version]);
      });
      appliedCount += 1;
      console.log(`applied\t${file.version}`);
    }
    console.log(`migration-complete\tapplied=${appliedCount}\tcurrent=${files.at(-1)?.version ?? "none"}`);
  } finally {
    if (migrationLockAcquired) await sql.unsafe("select pg_advisory_unlock($1::bigint)", [MIGRATION_LOCK_KEY]).catch(() => undefined);
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(`migration-failed\t${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
