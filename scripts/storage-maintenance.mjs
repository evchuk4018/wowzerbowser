import postgres from "postgres";
import { isStorageObjectId } from "../lib/storage-protocol.mjs";
import {
  applicationStorageRoot,
  cleanupApplicationTemporaryFiles,
  deleteApplicationObjectFile,
  ensureApplicationStorageDirectories,
} from "../lib/local-filesystem-storage.mjs";

export async function runStorageMaintenance({ olderThanMs = 60 * 60 * 1_000, limit = 100 } = {}) {
  applicationStorageRoot();
  await ensureApplicationStorageDirectories();
  const boundedLimit = Math.max(1, Math.min(limit, 100));
  const cutoff = new Date(Date.now() - Math.max(0, olderThanMs));
  let cleaned = await cleanupApplicationTemporaryFiles({ olderThanMs, limit: boundedLimit });
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const ownerId = process.env.APP_OWNER_ID?.trim();
  if (!databaseUrl || !ownerId || !isStorageObjectId(ownerId)) return cleaned;
  const sql = postgres(databaseUrl, { max: 1, connect_timeout: 5, idle_timeout: 5, prepare: true, onnotice: () => {} });
  try {
    const rows = await sql.unsafe("select object_id,object_key from app_storage_objects where owner_id=$1::uuid and state in ('uploading','failed') and created_at < $2 order by created_at limit $3", [ownerId, cutoff.toISOString(), Math.max(0, boundedLimit - cleaned)]);
    for (const row of rows) {
      if (!isStorageObjectId(String(row.object_id)) || typeof row.object_key !== "string") continue;
      await deleteApplicationObjectFile({ objectKey: row.object_key });
      await sql.unsafe("delete from app_storage_objects where owner_id=$1::uuid and object_id=$2::uuid", [ownerId, row.object_id]);
      cleaned += 1;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
  return cleaned;
}

if (process.argv.includes("--once")) {
  runStorageMaintenance().then((count) => {
    console.log(JSON.stringify({ event: "storage-maintenance-complete", cleaned: count }));
  }).catch((error) => {
    console.error(JSON.stringify({ event: "storage-maintenance-failed", error: error instanceof Error ? error.message : "unknown" }));
    process.exitCode = 1;
  });
}
