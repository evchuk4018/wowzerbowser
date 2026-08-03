import { existsSync, statSync } from "node:fs";

const heartbeatFile = process.env.WORKER_HEARTBEAT_FILE || "/tmp/wowzerbowser-background-worker.heartbeat";
const heartbeatMaxAgeMs = boundedInteger(process.env.WORKER_HEARTBEAT_MAX_AGE_MS, 30_000, 5_000, 300_000);

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

if (process.argv.includes("--health")) {
  try {
    if (!existsSync(heartbeatFile) || Date.now() - statSync(heartbeatFile).mtimeMs > heartbeatMaxAgeMs) process.exit(1);
    process.exit(0);
  } catch {
    process.exit(1);
  }
}

await import("../worker/background-worker.mjs");
