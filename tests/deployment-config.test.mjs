import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Compose defines the application services and private OpenDataLoader backend", async () => {
  const compose = await read("compose.yaml");
  for (const service of ["postgres", "opendataloader-hybrid", "web", "background-worker"]) {
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

test("search and retrieval services stay private to the Compose network", async () => {
  const compose = await read("compose.yaml");
  for (const service of ["searxng", "redlib", "miniflux", "firecrawl"]) {
    const start = compose.indexOf(`  ${service}:`);
    assert.ok(start >= 0, `${service} service is missing`);
    const relativeNext = compose.slice(start + 1).search(/\n  [a-z][a-z0-9-]*:\r?\n/m);
    const next = relativeNext < 0 ? -1 : start + 1 + relativeNext;
    const block = compose.slice(start, next < 0 ? compose.length : next);
    assert.doesNotMatch(block, /^    ports:/m, `${service} must not publish a host port`);
  }
  assert.match(compose, /SEARXNG_URL: \$\{SEARXNG_URL:-http:\/\/searxng:8080\}/);
  assert.match(compose, /FIRECRAWL_URL: \$\{FIRECRAWL_URL:-http:\/\/firecrawl:3002\}/);
  assert.match(compose, /rabbitmq-diagnostics.*\n\s+interval: 10s\n\s+timeout: 20s\n\s+retries: 6\n\s+start_period: 120s/s);
  assert.match(compose, /wget --spider --quiet http:\/\/127\.0\.0\.1:8080\/; status=\$\$\?; test \$\$status -eq 0 -o \$\$status -eq 8/);
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

test("background worker runs the PostgreSQL queue with bounded maintenance", async () => {
  const worker = await read("scripts/background-worker.ts");
  const wrapper = await read("scripts/background-worker.mjs");
  assert.match(worker, /mode: "postgresql-durable-queue"/);
  assert.match(worker, /claimNextChatJob/);
  assert.match(worker, /claimNextDocumentProcessingJob/);
  assert.match(worker, /runClaimedChatJob/);
  assert.match(worker, /runClaimedDocumentProcessingJob/);
  assert.match(worker, /runClaimedChatImageProcessingJob/);
  assert.match(worker, /runStorageMaintenance/);
  assert.match(worker, /chatConcurrency/);
  assert.match(worker, /imageConcurrency/);
  assert.match(worker, /ocrConcurrency/);
  assert.match(worker, /background-worker-queue-poll/);
  assert.match(wrapper, /--health/);
});

test("OpenDataLoader uses a private bounded hybrid runtime", async () => {
  const compose = await read("compose.yaml");
  const appDockerfile = await read("Dockerfile");
  const hybridDockerfile = await read("docker/opendataloader/Dockerfile");
  const packageJson = await read("package.json");
  const hybridBlock = compose.slice(compose.indexOf("  opendataloader-hybrid:"), compose.indexOf("  web:"));

  assert.match(hybridBlock, /dockerfile: docker\/opendataloader\/Dockerfile/);
  assert.doesNotMatch(hybridBlock, /^    ports:/m);
  assert.match(hybridBlock, /health.*\n\s+test:.*\/health/s);
  assert.match(hybridBlock, /cpus: "2\.00"/);
  assert.match(hybridBlock, /mem_limit: 3g/);
  assert.match(compose, /opendataloader-model-cache:/);
  assert.match(compose, /OPENDATALOADER_HYBRID_URL: \$\{OPENDATALOADER_HYBRID_URL:-http:\/\/opendataloader-hybrid:5002\}/);
  assert.match(appDockerfile, /openjdk-17-jre-headless/);
  assert.match(appDockerfile, /node_modules\/@opendataloader/);
  assert.equal(JSON.parse(packageJson).dependencies["@opendataloader/pdf"], "2.5.0");
  assert.match(hybridDockerfile, /python:3\.12/);
  assert.match(hybridDockerfile, /openjdk-17-jre-headless/);
  assert.match(hybridDockerfile, /opendataloader-pdf\[hybrid\]==2\.5\.0/);
  assert.match(hybridDockerfile, /--device.*cpu/);
  assert.match(hybridDockerfile, /--ocr-engine.*easyocr/);
  assert.match(hybridDockerfile, /--ocr-lang.*en/);
  assert.match(hybridDockerfile, /TORCH_HOME=\/var\/cache\/opendataloader\/torch/);
});
