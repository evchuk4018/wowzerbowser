import { lstat, mkdir, opendir, unlink } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";

const DEFAULT_ROOT = "/srv/storage/wowzerbowser";
const MEDIA_ROOT = path.resolve("/srv/storage/media");
const OBJECT_KEY = /^objects\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function storageRoot() {
  const root = path.resolve(process.env.APP_STORAGE_ROOT?.trim() || DEFAULT_ROOT);
  const relative = path.relative(MEDIA_ROOT, root);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) throw new Error("Application storage cannot use the media directory.");
  return root;
}

async function ensureDirectory(directory) {
  await mkdir(directory, { recursive: true });
  const details = await lstat(directory);
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error(`Storage maintenance path is not a real directory: ${directory}`);
}

async function objectPath(root, objectKey) {
  if (!OBJECT_KEY.test(objectKey) || objectKey.includes("\\") || objectKey.includes("..")) throw new Error("Invalid storage object key.");
  const files = path.join(root, "files");
  const target = path.resolve(files, ...objectKey.split("/"));
  const relative = path.relative(files, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Storage object path escapes the application root.");
  return target;
}

async function deleteExactObject(root, objectKey) {
  const files = path.join(root, "files");
  const objects = path.join(files, "objects");
  const filesDetails = await lstat(files);
  const objectsDetails = await lstat(objects);
  if (filesDetails.isSymbolicLink() || !filesDetails.isDirectory() || objectsDetails.isSymbolicLink() || !objectsDetails.isDirectory()) throw new Error("Refusing to remove an object through a symlinked storage directory.");
  const target = await objectPath(root, objectKey);
  try {
    const details = await lstat(target);
    if (details.isSymbolicLink() || !details.isFile()) throw new Error("Refusing to remove a non-regular storage object.");
    await unlink(target);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function cleanupTemporaryFiles(root, cutoff, limit) {
  if (limit <= 0) return 0;
  const directory = path.join(root, "files", ".tmp");
  await ensureDirectory(directory);
  let removed = 0;
  const handle = await opendir(directory);
  try {
    let inspected = 0;
    for await (const entry of handle) {
      if (inspected >= limit) break;
      inspected += 1;
      if (removed >= limit || !entry.name.endsWith(".uploading")) continue;
      const target = path.join(directory, entry.name);
      const details = await lstat(target).catch(() => null);
      if (!details || details.isSymbolicLink() || !details.isFile() || details.mtimeMs > cutoff) continue;
      await unlink(target);
      removed += 1;
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  return removed;
}

export async function runStorageMaintenance({ olderThanMs = 60 * 60 * 1_000, limit = 100 } = {}) {
  const root = storageRoot();
  await ensureDirectory(root);
  await ensureDirectory(path.join(root, "files"));
  await ensureDirectory(path.join(root, "files", "objects"));
  const boundedLimit = Math.max(1, Math.min(limit, 100));
  const cutoff = new Date(Date.now() - Math.max(0, olderThanMs));
  let cleaned = await cleanupTemporaryFiles(root, cutoff.getTime(), boundedLimit);
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const ownerId = process.env.APP_OWNER_ID?.trim();
  if (!databaseUrl || !ownerId || !UUID.test(ownerId)) return cleaned;
  const sql = postgres(databaseUrl, { max: 1, connect_timeout: 5, idle_timeout: 5, prepare: true, onnotice: () => {} });
  try {
    const rows = await sql.unsafe("select object_id,object_key from app_storage_objects where owner_id=$1::uuid and state in ('uploading','failed') and created_at < $2 order by created_at limit $3", [ownerId, cutoff.toISOString(), Math.max(0, boundedLimit - cleaned)]);
    for (const row of rows) {
      if (!UUID.test(String(row.object_id)) || typeof row.object_key !== "string") continue;
      await deleteExactObject(root, row.object_key);
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
