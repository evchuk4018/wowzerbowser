import { existsSync, statSync, writeFileSync } from "node:fs";
import { runStorageMaintenance } from "./storage-maintenance.mjs";

const heartbeatFile = process.env.WORKER_HEARTBEAT_FILE || "/tmp/wowzerbowser-background-worker.heartbeat";
const heartbeatIntervalMs = boundedInteger(process.env.WORKER_HEARTBEAT_INTERVAL_MS, 5_000, 1_000, 60_000);
const heartbeatMaxAgeMs = boundedInteger(process.env.WORKER_HEARTBEAT_MAX_AGE_MS, 30_000, 5_000, 300_000);
const storageMaintenanceIntervalMs = boundedInteger(process.env.STORAGE_MAINTENANCE_INTERVAL_MS, 60_000, 10_000, 3_600_000);

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function writeHeartbeat() {
  writeFileSync(heartbeatFile, `${new Date().toISOString()}\n`, "utf8");
}

if (process.argv.includes("--health")) {
  try {
    if (!existsSync(heartbeatFile) || Date.now() - statSync(heartbeatFile).mtimeMs > heartbeatMaxAgeMs) process.exit(1);
    process.exit(0);
  } catch {
    process.exit(1);
  }
}

console.log(JSON.stringify({
  event: "background-worker-started",
  mode: "local-storage-maintenance",
  chatConcurrency: boundedInteger(process.env.WORKER_CHAT_CONCURRENCY, 1, 1, 1),
  ocrConcurrency: boundedInteger(process.env.WORKER_OCR_CONCURRENCY, 2, 1, 2),
  limitation: "Durable chat job execution remains in the Next.js process; this worker owns bounded storage maintenance.",
}));

writeHeartbeat();
const timer = setInterval(writeHeartbeat, heartbeatIntervalMs);
let maintenanceRunning = false;
async function maintainStorage() {
  if (maintenanceRunning) return;
  maintenanceRunning = true;
  try {
    const cleaned = await runStorageMaintenance();
    if (cleaned) console.log(JSON.stringify({ event: "storage-maintenance", cleaned }));
  } catch (error) {
    console.error(JSON.stringify({ event: "storage-maintenance-failed", error: error instanceof Error ? error.message : "unknown" }));
  } finally {
    maintenanceRunning = false;
  }
}
void maintainStorage();
const maintenanceTimer = setInterval(() => void maintainStorage(), storageMaintenanceIntervalMs);

function shutdown(signal) {
  clearInterval(timer);
  clearInterval(maintenanceTimer);
  console.log(JSON.stringify({ event: "background-worker-stopped", signal }));
  process.exit(0);
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

await new Promise(() => {});
