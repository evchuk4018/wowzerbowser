import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runtimeConfigurationIssues } from "../lib/runtime-preflight.mjs";

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");

test("runtime preflight rejects hosted or unsafe installation assumptions", () => {
  const valid = runtimeConfigurationIssues({
    DATABASE_URL: "postgresql://app:password@postgres:5432/app",
    APP_OWNER_EMAIL: "owner@example.test",
    APP_OWNER_ID: "11111111-1111-4111-8111-111111111111",
    NEXT_PUBLIC_SITE_URL: "https://homelab.example.test",
    APP_STORAGE_ROOT: "/srv/storage/wowzerbowser",
    NODE_ENV: "production",
    STORAGE_MOUNT_GUARD: "verified",
  });
  assert.deepEqual(valid, []);
  assert.ok(runtimeConfigurationIssues({
    DATABASE_URL: "https://hosted.example.test/db",
    APP_OWNER_EMAIL: "owner@example.test",
    APP_OWNER_ID: "not-a-uuid",
    NEXT_PUBLIC_SITE_URL: "https://homelab.example.test",
    APP_STORAGE_ROOT: "/srv/storage/media/files",
    NODE_ENV: "production",
    STORAGE_MOUNT_GUARD: "unverified",
  }).map(({ code }) => code).includes("storage_root_is_media"));
});

test("the startup path, health route, and update procedure use local readiness boundaries", async () => {
  const [entrypoint, health, update, smoke] = await Promise.all([
    read("docker/app-entrypoint.sh"),
    read("app/api/health/route.ts"),
    read("docker/update.sh"),
    read("scripts/clean-install-smoke.mjs"),
  ]);
  assert.match(entrypoint, /runtime-preflight\.mjs --startup/u);
  assert.match(entrypoint, /migrate\.mjs --check/u);
  assert.match(health, /getReadinessReport/u);
  assert.match(health, /503/u);
  assert.match(update, /git pull --ff-only origin main/u);
  assert.match(update, /migrate\.mjs --initialize/u);
  assert.doesNotMatch(update, /down\s+-v/u);
  for (const boundary of ["response.body?.cancel", "documents/upload", "api/automations", "api/memory", "restart", "media"]) {
    assert.match(smoke, new RegExp(boundary.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
});
