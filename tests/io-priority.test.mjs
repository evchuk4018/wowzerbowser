import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const policyPath = join(root, "ops", "io-priority", "apply.sh");
const composePath = join(root, "compose.yaml");
const installerPath = join(root, "docker", "install-io-priority.sh");
const dockerIgnorePath = join(root, ".dockerignore");

test("I/O policy defines bounded relative weights and a safe default", async () => {
  const policy = await readFile(policyPath, "utf8");
  assert.match(policy, /readonly INTERACTIVE_WEIGHT=1000/);
  assert.match(policy, /readonly USER_WORK_WEIGHT=650/);
  assert.match(policy, /readonly BACKGROUND_WEIGHT=250/);
  assert.match(policy, /readonly BULK_WEIGHT=100/);
  assert.match(policy, /readonly DEFAULT_WEIGHT=200/);
  assert.match(policy, /docker update --blkio-weight/);
  assert.match(policy, /cgroup\.controllers/);
  assert.match(policy, /grep -qw io/);
});

test("known interactive and background services are covered", async () => {
  const policy = await readFile(policyPath, "utf8");
  for (const name of [
    "app-web-1",
    "hometube-worker-1",
    "wowzerbowser-background-worker-1",
    "media-jellyfin",
    "media-qbittorrent",
    "media-radarr",
    "media-sonarr",
    "wowzerbowser-opendataloader-hybrid-1",
  ]) {
    assert.match(policy, new RegExp(`\\[${name.replaceAll("-", "\\-")}\\]`));
  }
});

test("Wowzer Compose contains static protection for recreated containers", async () => {
  const compose = await readFile(composePath, "utf8");
  assert.equal((compose.match(/blkio_config:/g) ?? []).length, 14);
  assert.match(compose, /x-io-interactive:/);
  assert.match(compose, /x-io-background:/);
  assert.match(compose, /x-io-bulk:/);
});

test("installer uses the persistent user systemd timer", async () => {
  const installer = await readFile(installerPath, "utf8");
  assert.match(installer, /systemctl --user daemon-reload/);
  assert.match(installer, /systemctl --user enable --now homelab-io-policy\.timer/);
  assert.match(installer, /XDG_RUNTIME_DIR/);
});

test("Docker build context excludes homelab runtime data", async () => {
  const dockerIgnore = await readFile(dockerIgnorePath, "utf8");
  for (const entry of ["hometube", "hometube-postgres", "hometube-media", "files", "deployment.env*"]) {
    assert.match(dockerIgnore, new RegExp(`^${entry.replace("*", "\\*")}$`, "m"));
  }
});
