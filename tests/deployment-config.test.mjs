import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Compose defines the three issue #62 core services", async () => {
  const compose = await read("compose.yaml");
  for (const service of ["postgres", "web", "background-worker"]) {
    assert.match(compose, new RegExp(`^  ${service}:$`, "m"));
  }
  assert.doesNotMatch(compose, /^  (redis|minio|caddy|nginx):$/m);
});

test("Compose keeps the app port localhost-only and PostgreSQL unpublished", async () => {
  const compose = await read("compose.yaml");
  assert.match(compose, /127\.0\.0\.1:\$\{WEB_PORT:-3000\}:3000/);
  assert.match(compose, /postgres-data:\/var\/lib\/postgresql\/data/);
  assert.match(compose, /user: "\$\{APP_UID:-1000\}:\$\{APP_GID:-1000\}"/);
  const postgresBlock = compose.slice(compose.indexOf("  postgres:"), compose.indexOf("  web:"));
  assert.doesNotMatch(postgresBlock, /^    ports:/m);
});

test("only the application storage directory is bind-mounted", async () => {
  const compose = await read("compose.yaml");
  assert.equal((compose.match(/source: \/srv\/storage\/wowzerbowser/g) ?? []).length, 2);
  assert.doesNotMatch(compose, /source:\s*\/srv\/storage\s*$/m);
  assert.doesNotMatch(compose, /\/srv\/storage\/media/);
});

test("startup is guarded by the host mount check and container isolation check", async () => {
  const wrapper = await read("docker/compose.sh");
  const guard = await read("docker/require-storage-mount.sh");
  const entrypoint = await read("docker/app-entrypoint.sh");
  assert.match(wrapper, /require-storage-mount\.sh/);
  assert.match(wrapper, /STORAGE_MOUNT_GUARD=verified/);
  assert.match(wrapper, /deployment\.env/);
  assert.match(wrapper, /--env-file/);
  assert.match(guard, /mountpoint -q/);
  assert.match(guard, /homelab-storage/);
  assert.match(guard, /root_source=\$\(findmnt/);
  assert.match(entrypoint, /STORAGE_MOUNT_GUARD/);
  assert.match(entrypoint, /\/srv\/storage\/media/);
});

test("background worker runs bounded local-storage maintenance", async () => {
  const worker = await read("scripts/background-worker.mjs");
  assert.match(worker, /mode: "local-storage-maintenance"/);
  assert.match(worker, /runStorageMaintenance/);
  assert.match(worker, /storageMaintenanceIntervalMs/);
  assert.match(worker, /--health/);
});
