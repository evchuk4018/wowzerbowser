import { constants as fsConstants } from "node:fs";
import { access, lstat, mkdir, open, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DEFAULT_STORAGE_ROOT = "/srv/storage/wowzerbowser";
const DEFAULT_FILES_ROOT = "/srv/storage/wowzerbowser/files";
const DEFAULT_OBJECTS_ROOT = "/srv/storage/wowzerbowser/files/objects";
const DEFAULT_TEMPORARY_ROOT = "/srv/storage/wowzerbowser/files/.tmp";
const FORBIDDEN_MEDIA_ROOT = "/srv/storage/media";

function required(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function addIssue(issues, code, message) {
  issues.push({ code, message });
}

/**
 * Validate only installation configuration. The returned messages are used by
 * the startup command; HTTP readiness responses expose codes only.
 */
export function runtimeConfigurationIssues(env = process.env) {
  const issues = [];
  if (!required(env.DATABASE_URL)) addIssue(issues, "database_url_missing", "DATABASE_URL is required.");
  else {
    try {
      const url = new URL(env.DATABASE_URL.trim());
      if (!['postgres:', 'postgresql:'].includes(url.protocol)) addIssue(issues, "database_url_invalid", "DATABASE_URL must use the postgres or postgresql scheme.");
    } catch {
      addIssue(issues, "database_url_invalid", "DATABASE_URL must be a valid PostgreSQL URL.");
    }
  }
  if (!required(env.APP_OWNER_EMAIL)) addIssue(issues, "owner_email_missing", "APP_OWNER_EMAIL is required.");
  if (!UUID_PATTERN.test(env.APP_OWNER_ID?.trim() ?? "")) addIssue(issues, "owner_id_invalid", "APP_OWNER_ID must be configured as a UUID.");

  const siteUrl = env.NEXT_PUBLIC_SITE_URL?.trim() ?? "";
  try {
    const url = new URL(siteUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error();
  } catch {
    addIssue(issues, "site_url_invalid", "NEXT_PUBLIC_SITE_URL must be an HTTP(S) URL without credentials.");
  }

  const configuredStorageRoot = env.APP_STORAGE_ROOT?.trim() || DEFAULT_STORAGE_ROOT;
  if (configuredStorageRoot === FORBIDDEN_MEDIA_ROOT || configuredStorageRoot.startsWith(`${FORBIDDEN_MEDIA_ROOT}/`)) addIssue(issues, "storage_root_is_media", "APP_STORAGE_ROOT cannot be /srv/storage/media or a child of it.");
  else if (configuredStorageRoot !== DEFAULT_STORAGE_ROOT) addIssue(issues, "storage_root_invalid", "APP_STORAGE_ROOT must be /srv/storage/wowzerbowser.");
  if (env.NODE_ENV === "production" && env.STORAGE_MOUNT_GUARD !== "verified") addIssue(issues, "storage_mount_unverified", "STORAGE_MOUNT_GUARD must be verified by the guarded Compose wrapper.");
  return issues;
}

export function validateRuntimeConfiguration(env = process.env) {
  const issues = runtimeConfigurationIssues(env);
  if (issues.length) throw new Error(`Runtime configuration is invalid: ${issues.map((issue) => issue.message).join(" ")}`);
  return { storageRoot: DEFAULT_STORAGE_ROOT, filesRoot: DEFAULT_FILES_ROOT, objectsRoot: DEFAULT_OBJECTS_ROOT, temporaryRoot: DEFAULT_TEMPORARY_ROOT };
}

async function assertRealDirectory(directory, label) {
  let details;
  try {
    details = await lstat(directory);
  } catch {
    throw new Error(`${label} is missing or inaccessible.`);
  }
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error(`${label} must be a real directory.`);
}

async function ensureDirectory(directory, label) {
  try {
    await mkdir(directory, { recursive: true });
  } catch {
    throw new Error(`${label} could not be created; check the HDD mount and permissions.`);
  }
  await assertRealDirectory(directory, label);
}

/**
 * Verify the application-owned storage tree and, when requested, create the
 * empty-install directories. The write probe is deliberately inside .tmp and
 * never touches the owner-managed media directory.
 */
export async function checkRuntimeStorage(options = {}) {
  const { createDirectories = false, probeWritable = true } = options;
  const paths = validateRuntimeConfiguration(options.env ?? process.env);
  if (await lstat(FORBIDDEN_MEDIA_ROOT).then(() => true).catch(() => false)) {
    throw new Error("/srv/storage/media is visible inside the application container.");
  }
  if (createDirectories) {
    await ensureDirectory(paths.storageRoot, "Application storage root");
    await ensureDirectory(paths.filesRoot, "Application files directory");
    await ensureDirectory(paths.objectsRoot, "Application objects directory");
    await ensureDirectory(paths.temporaryRoot, "Application temporary directory");
  } else {
    await assertRealDirectory(paths.storageRoot, "Application storage root");
    await assertRealDirectory(paths.filesRoot, "Application files directory");
    await assertRealDirectory(paths.objectsRoot, "Application objects directory");
    await assertRealDirectory(paths.temporaryRoot, "Application temporary directory");
  }
  if (!probeWritable) return paths;
  try {
    await access(paths.storageRoot, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK);
    await access(paths.filesRoot, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK);
    const probePath = `${paths.temporaryRoot}/.runtime-preflight-${process.pid}-${randomUUID()}`;
    const handle = await open(probePath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    try {
      await handle.writeFile("wowzerbowser-runtime-preflight\n", "utf8");
      await handle.sync();
    } finally {
      await handle.close().catch(() => undefined);
      await unlink(probePath).catch(() => undefined);
    }
  } catch {
    throw new Error("Application storage is not readable, writable, and executable by the container user.");
  }
  return paths;
}

async function main() {
  if (!process.argv.includes("--startup")) throw new Error("Usage: node scripts/runtime-preflight.mjs --startup");
  validateRuntimeConfiguration();
  await checkRuntimeStorage({ createDirectories: true, probeWritable: true });
  console.log("runtime-preflight\tready");
}

if (process.argv.includes("--startup")) {
  main().catch((error) => {
    console.error(`startup-preflight-failed\t${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  });
}
