import { rename, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";

const outputFlag = process.argv.indexOf("--output");
const outputPath = outputFlag >= 0 && process.argv[outputFlag + 1]
  ? process.argv[outputFlag + 1]
  : path.join(process.env.APP_STORAGE_ROOT || "/srv/storage/wowzerbowser", "config", "runtime.env");
const connectionString = process.env.DATABASE_URL?.trim();
const ownerId = process.env.APP_OWNER_ID?.trim();
if (!connectionString || !ownerId) throw new Error("DATABASE_URL and APP_OWNER_ID are required.");

const exported = new Map([
  ["SEARXNG_URL", "searxngUrl"], ["MEDIAWIKI_API_URL", "mediawikiApiUrl"], ["MINIFLUX_URL", "minifluxUrl"],
  ["FIRECRAWL_URL", "firecrawlUrl"], ["OPENDATALOADER_HYBRID_URL", "opendataloaderHybridUrl"], ["PYTHON_WORKER_URL", "pythonWorkerUrl"],
  ["SEARCH_PROVIDER_CACHE_TTL_MS", "searchProviderCacheTtlMs"], ["SEARCH_PROVIDER_FAILURE_THRESHOLD", "searchProviderFailureThreshold"], ["SEARCH_PROVIDER_CIRCUIT_OPEN_MS", "searchProviderCircuitOpenMs"],
  ["FIRECRAWL_MAX_CONCURRENT_PAGES", "firecrawlMaxConcurrentPages"], ["FIRECRAWL_MAX_CONCURRENT_JOBS", "firecrawlMaxConcurrentJobs"], ["FIRECRAWL_BROWSER_POOL_SIZE", "firecrawlBrowserPoolSize"],
  ["WORKER_CHAT_CONCURRENCY", "workerChatConcurrency"], ["WORKER_DOCUMENT_CONCURRENCY", "workerDocumentConcurrency"], ["WORKER_IMAGE_CONCURRENCY", "workerImageConcurrency"], ["WORKER_OCR_CONCURRENCY", "workerOcrConcurrency"],
  ["PDF_OCR_CONCURRENCY", "pdfOcrConcurrency"], ["PDF_IMAGE_ANALYSIS_CONCURRENCY", "pdfImageAnalysisConcurrency"], ["WORKER_POLL_INTERVAL_MS", "workerPollIntervalMs"],
  ["WORKER_HEARTBEAT_INTERVAL_MS", "workerHeartbeatIntervalMs"], ["WORKER_HEARTBEAT_MAX_AGE_MS", "workerHeartbeatMaxAgeMs"], ["STORAGE_MAINTENANCE_INTERVAL_MS", "storageMaintenanceIntervalMs"],
  ["AUTOMATION_SCHEDULER_INTERVAL_MS", "automationSchedulerIntervalMs"], ["AUTOMATION_SCHEDULER_BATCH", "automationSchedulerBatch"], ["MEMORY_SCHEDULER_INTERVAL_MS", "memorySchedulerIntervalMs"],
  ["WORKER_MAINTENANCE_LIMIT", "workerMaintenanceLimit"], ["DISCORD_PROCESSING_INTERVAL_MS", "discordProcessingIntervalMs"],
]);

function shellValue(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

const sql = postgres(connectionString, { max: 1, connect_timeout: 10, idle_timeout: 10, onnotice: () => undefined });
try {
  let rows = [];
  try { rows = await sql.unsafe("select values from runtime_configurations where owner_id = $1", [ownerId]); }
  catch (error) { if (!(error && typeof error === "object" && error.code === "42P01")) throw error; }
  const values = rows[0]?.values && typeof rows[0].values === "object" ? rows[0].values : {};
  const lines = [];
  for (const [environmentName, key] of exported) {
    if (!Object.prototype.hasOwnProperty.call(values, key)) continue;
    const value = values[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") lines.push(`${environmentName}=${shellValue(value)}`);
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${lines.join("\n")}${lines.length ? "\n" : ""}`, { encoding: "utf8", mode: 0o640 });
  await rename(temporary, outputPath);
  console.log(`runtime-config-exported\t${outputPath}\tkeys=${lines.length}`);
} finally { await sql.end({ timeout: 5 }); }
