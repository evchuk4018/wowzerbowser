import {
  applicationStorageRoot,
  cleanupApplicationTemporaryFiles,
  ensureApplicationStorageDirectories,
} from "../lib/local-filesystem-storage.mjs";

/**
 * Compatibility CLI for temporary-file cleanup. The background worker owns
 * database-backed incomplete-file cleanup through the storage service; this
 * small adapter only handles filesystem temporary entries.
 */
export async function runStorageMaintenance({ olderThanMs = 60 * 60 * 1_000, limit = 100 } = {}) {
  applicationStorageRoot();
  await ensureApplicationStorageDirectories();
  return cleanupApplicationTemporaryFiles({
    olderThanMs,
    limit: Math.max(1, Math.min(limit, 100)),
  });
}

if (process.argv.includes("--once")) {
  runStorageMaintenance().then((count) => {
    console.log(JSON.stringify({ event: "storage-maintenance-complete", cleaned: count }));
  }).catch(() => {
    console.error(JSON.stringify({ event: "storage-maintenance-failed" }));
    process.exitCode = 1;
  });
}
