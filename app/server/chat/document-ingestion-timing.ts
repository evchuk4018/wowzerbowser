/**
 * These values are part of the observability contract. Keep them stable: they
 * are used as Server-Timing metric names and by dashboards consuming logs.
 */
export const DOCUMENT_INGESTION_STAGES = {
  STORAGE_UPLOAD: "storage-upload",
  APPLICATION_UPLOAD: "application-upload",
  FINALIZE_REQUEST: "finalize-request",
  STORAGE_READ: "storage-read",
  NATIVE_PARSING: "native-parsing",
  EXTERNAL_PARSING: "external-parsing",
  PAGE_RENDERING: "page-rendering",
  OCR: "ocr",
  DOCX_IMAGE_ANALYSIS: "docx-image-analysis",
  DATABASE_REGISTRATION: "database-registration",
  TOTAL_PREPARATION: "total-preparation",
} as const;

export type DocumentIngestionStage = (typeof DOCUMENT_INGESTION_STAGES)[keyof typeof DOCUMENT_INGESTION_STAGES];

export const DOCUMENT_INGESTION_STAGE_ORDER: readonly DocumentIngestionStage[] = Object.freeze([
  DOCUMENT_INGESTION_STAGES.STORAGE_UPLOAD,
  DOCUMENT_INGESTION_STAGES.APPLICATION_UPLOAD,
  DOCUMENT_INGESTION_STAGES.FINALIZE_REQUEST,
  DOCUMENT_INGESTION_STAGES.STORAGE_READ,
  DOCUMENT_INGESTION_STAGES.NATIVE_PARSING,
  DOCUMENT_INGESTION_STAGES.EXTERNAL_PARSING,
  DOCUMENT_INGESTION_STAGES.PAGE_RENDERING,
  DOCUMENT_INGESTION_STAGES.OCR,
  DOCUMENT_INGESTION_STAGES.DOCX_IMAGE_ANALYSIS,
  DOCUMENT_INGESTION_STAGES.DATABASE_REGISTRATION,
  DOCUMENT_INGESTION_STAGES.TOTAL_PREPARATION,
]);

export type DocumentIngestionCacheStatus = "hit" | "miss" | "bypass" | "unknown";

export interface DocumentIngestionTimingMetadata {
  documentType?: string | null;
  byteSize?: number | null;
  pageCount?: number | null;
  ocrPageCount?: number | null;
  cacheStatus?: DocumentIngestionCacheStatus | boolean | string | null;
  fallbackUsed?: boolean;
}

export interface DocumentIngestionTimingOptions {
  /** Monotonic milliseconds; useful for deterministic tests and custom runtimes. */
  now?: () => number;
  logger?: DocumentIngestionTimingLogger;
  autoStartTotal?: boolean;
}

export interface DocumentIngestionStageTiming {
  stage: DocumentIngestionStage;
  durationMs: number;
  status: "completed" | "failed";
  count: number;
}

export interface DocumentIngestionTimingSnapshot {
  documentType: string;
  byteSize: number | null;
  pageCount: number | null;
  ocrPageCount: number | null;
  cacheStatus: DocumentIngestionCacheStatus;
  durationMs: number;
  failedStage: DocumentIngestionStage | null;
  failedStages: readonly DocumentIngestionStage[];
  fallbackUsed?: true;
  stageDurations: Readonly<Partial<Record<DocumentIngestionStage, number>>>;
  stages: readonly DocumentIngestionStageTiming[];
  completed: boolean;
}

export interface DocumentIngestionTimingLogEntry {
  event: "document-ingestion-timing";
  documentType: string;
  byteSize: number | null;
  pageCount: number | null;
  ocrPageCount: number | null;
  cacheStatus: DocumentIngestionCacheStatus;
  durationMs: number;
  failedStage: DocumentIngestionStage | null;
  failedStages: readonly DocumentIngestionStage[];
  fallbackUsed?: true;
  stages: Readonly<Partial<Record<DocumentIngestionStage, number>>>;
}

export type DocumentIngestionTimingLogger = (entry: DocumentIngestionTimingLogEntry) => void;

export interface DocumentIngestionStageSpan {
  end(): DocumentIngestionStageTiming;
  fail(): DocumentIngestionStageTiming;
}

type TimingRecord = {
  durationMs: number;
  status: "completed" | "failed";
  count: number;
};

const DEFAULT_NOW = (): number => {
  if (typeof performance !== "undefined" && typeof performance.now === "function") return performance.now();
  return Date.now();
};

const DOCUMENT_TYPE_PATTERN = /^(?:[a-z0-9][a-z0-9+.-]{0,31}|[a-z0-9!#$&^_.+-]{1,63}\/[a-z0-9!#$&^_.+-]{1,127})$/i;
const CACHE_STATUSES = new Set<DocumentIngestionCacheStatus>(["hit", "miss", "bypass", "unknown"]);
const STAGE_SET = new Set<DocumentIngestionStage>(DOCUMENT_INGESTION_STAGE_ORDER);

function safeDocumentType(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  const normalized = value.trim().toLowerCase();
  return DOCUMENT_TYPE_PATTERN.test(normalized) ? normalized : "unknown";
}

function safeNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeCacheStatus(value: unknown): DocumentIngestionCacheStatus {
  if (value === true) return "hit";
  if (value === false) return "miss";
  if (typeof value !== "string") return "unknown";
  const normalized = value.trim().toLowerCase();
  return CACHE_STATUSES.has(normalized as DocumentIngestionCacheStatus)
    ? normalized as DocumentIngestionCacheStatus
    : "unknown";
}

function safeDuration(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.round(value * 100) / 100;
}

function elapsed(now: () => number, startedAt: number): number {
  const current = now();
  return safeDuration(Math.max(0, current - startedAt));
}

function assertStage(stage: string): asserts stage is DocumentIngestionStage {
  if (!STAGE_SET.has(stage as DocumentIngestionStage)) throw new Error(`Unknown document ingestion timing stage: ${stage}`);
}

function stageEntries(value: ServerTimingSource): Array<[DocumentIngestionStage, number]> {
  if (value instanceof DocumentIngestionTiming) return stageEntries(value.snapshot());
  if (value instanceof Map) {
    return Array.from(value.entries()).flatMap(([stage, duration]) => STAGE_SET.has(stage as DocumentIngestionStage) && typeof duration === "number"
      ? [[stage as DocumentIngestionStage, safeDuration(duration)] as [DocumentIngestionStage, number]]
      : []);
  }
  if (Array.isArray(value)) {
    return value.flatMap((stageTiming) => STAGE_SET.has(stageTiming.stage) ? [[stageTiming.stage, safeDuration(stageTiming.durationMs)]] : []);
  }
  if ("stageDurations" in value) return stageEntries(value.stageDurations);
  return Object.entries(value).flatMap(([stage, duration]) => STAGE_SET.has(stage as DocumentIngestionStage) && typeof duration === "number"
    ? [[stage as DocumentIngestionStage, safeDuration(duration)] as [DocumentIngestionStage, number]]
    : []);
}

export type ServerTimingSource =
  | DocumentIngestionTiming
  | DocumentIngestionTimingSnapshot
  | ReadonlyMap<DocumentIngestionStage, number>
  | readonly DocumentIngestionStageTiming[]
  | Readonly<Partial<Record<DocumentIngestionStage, number>>>;

/**
 * Tracks one document preparation operation. Stage durations are aggregated,
 * which keeps parallel OCR/image work representable as one stable metric.
 */
export class DocumentIngestionTiming {
  private readonly now: () => number;
  private readonly logger?: DocumentIngestionTimingLogger;
  private readonly startedAt: number;
  private readonly records = new Map<DocumentIngestionStage, TimingRecord>();
  private readonly active = new Set<DocumentIngestionStage>();
  private readonly failed = new Set<DocumentIngestionStage>();
  private readonly autoStartTotal: boolean;
  private metadata: {
    documentType: string;
    byteSize: number | null;
    pageCount: number | null;
    ocrPageCount: number | null;
    cacheStatus: DocumentIngestionCacheStatus;
    fallbackUsed?: true;
  };
  private totalEnded = false;

  constructor(metadata: DocumentIngestionTimingMetadata = {}, options: DocumentIngestionTimingOptions = {}) {
    this.now = options.now ?? DEFAULT_NOW;
    this.logger = options.logger;
    this.autoStartTotal = options.autoStartTotal !== false;
    this.startedAt = this.now();
    this.metadata = {
      documentType: safeDocumentType(metadata.documentType),
      byteSize: safeNonNegativeInteger(metadata.byteSize),
      pageCount: safeNonNegativeInteger(metadata.pageCount),
      ocrPageCount: safeNonNegativeInteger(metadata.ocrPageCount),
      cacheStatus: safeCacheStatus(metadata.cacheStatus),
      ...(metadata.fallbackUsed === true ? { fallbackUsed: true as const } : {}),
    };

  }

  updateMetadata(metadata: DocumentIngestionTimingMetadata): this {
    if (metadata.documentType !== undefined) this.metadata.documentType = safeDocumentType(metadata.documentType);
    if (metadata.byteSize !== undefined) this.metadata.byteSize = safeNonNegativeInteger(metadata.byteSize);
    if (metadata.pageCount !== undefined) this.metadata.pageCount = safeNonNegativeInteger(metadata.pageCount);
    if (metadata.ocrPageCount !== undefined) this.metadata.ocrPageCount = safeNonNegativeInteger(metadata.ocrPageCount);
    if (metadata.cacheStatus !== undefined) this.metadata.cacheStatus = safeCacheStatus(metadata.cacheStatus);
    if (metadata.fallbackUsed !== undefined) {
      if (metadata.fallbackUsed) this.metadata.fallbackUsed = true;
      else delete this.metadata.fallbackUsed;
    }
    return this;
  }

  begin(stage: DocumentIngestionStage): DocumentIngestionStageSpan {
    assertStage(stage);
    if (stage === DOCUMENT_INGESTION_STAGES.TOTAL_PREPARATION && this.totalEnded) {
      throw new Error("Total preparation timing has already started.");
    }
    const startedAt = this.now();
    let ended = false;
    this.active.add(stage);

    const complete = (status: "completed" | "failed"): DocumentIngestionStageTiming => {
      if (ended) throw new Error(`Document ingestion timing stage has already ended: ${stage}`);
      ended = true;
      this.active.delete(stage);
      return this.recordStage(stage, elapsed(this.now, startedAt), status);
    };

    return {
      end: () => complete("completed"),
      fail: () => complete("failed"),
    };
  }

  start(stage: DocumentIngestionStage): DocumentIngestionStageSpan {
    return this.begin(stage);
  }

  recordStage(stage: DocumentIngestionStage, durationMs: number, status: "completed" | "failed" = "completed"): DocumentIngestionStageTiming {
    assertStage(stage);
    const prior = this.records.get(stage);
    const record: TimingRecord = {
      durationMs: safeDuration((prior?.durationMs ?? 0) + durationMs),
      status: prior?.status === "failed" || status === "failed" ? "failed" : "completed",
      count: (prior?.count ?? 0) + 1,
    };
    this.records.set(stage, record);
    if (record.status === "failed") this.failed.add(stage);
    if (stage === DOCUMENT_INGESTION_STAGES.TOTAL_PREPARATION) this.totalEnded = true;
    return { stage, ...record };
  }

  markFailed(stage: DocumentIngestionStage, durationMs = 0): DocumentIngestionStageTiming {
    return this.recordStage(stage, durationMs, "failed");
  }

  async measure<T>(stage: DocumentIngestionStage, operation: () => Promise<T> | T): Promise<T> {
    const span = this.begin(stage);
    try {
      const result = await operation();
      span.end();
      return result;
    } catch (error) {
      span.fail();
      throw error;
    }
  }

  measureSync<T>(stage: DocumentIngestionStage, operation: () => T): T {
    const span = this.begin(stage);
    try {
      const result = operation();
      span.end();
      return result;
    } catch (error) {
      span.fail();
      throw error;
    }
  }

  finish(): DocumentIngestionTimingSnapshot {
    if (!this.totalEnded && this.autoStartTotal) {
      this.recordStage(DOCUMENT_INGESTION_STAGES.TOTAL_PREPARATION, elapsed(this.now, this.startedAt));
    }
    return this.snapshot(true);
  }

  complete(): DocumentIngestionTimingSnapshot {
    return this.finish();
  }

  snapshot(completed = false): DocumentIngestionTimingSnapshot {
    const stages = DOCUMENT_INGESTION_STAGE_ORDER.flatMap((stage) => {
      const record = this.records.get(stage);
      return record ? [{ stage, ...record }] : [];
    });
    const stageDurations: Partial<Record<DocumentIngestionStage, number>> = {};
    for (const stage of stages) stageDurations[stage.stage] = stage.durationMs;
    return {
      ...this.metadata,
      durationMs: safeDuration(this.records.get(DOCUMENT_INGESTION_STAGES.TOTAL_PREPARATION)?.durationMs ?? elapsed(this.now, this.startedAt)),
      failedStage: this.failedStage,
      failedStages: this.failedStages,
      stageDurations,
      stages,
      completed: completed || this.totalEnded,
    };
  }

  get failedStage(): DocumentIngestionStage | null {
    return this.failedStages.at(-1) ?? null;
  }

  get failedStages(): readonly DocumentIngestionStage[] {
    return DOCUMENT_INGESTION_STAGE_ORDER.filter((stage) => this.failed.has(stage));
  }

  get fallbackUsed(): boolean {
    return this.metadata.fallbackUsed === true;
  }

  toLogEntry(): DocumentIngestionTimingLogEntry {
    const snapshot = this.snapshot();
    return {
      event: "document-ingestion-timing",
      documentType: snapshot.documentType,
      byteSize: snapshot.byteSize,
      pageCount: snapshot.pageCount,
      ocrPageCount: snapshot.ocrPageCount,
      cacheStatus: snapshot.cacheStatus,
      durationMs: snapshot.durationMs,
      failedStage: snapshot.failedStage,
      failedStages: snapshot.failedStages,
      ...(snapshot.fallbackUsed ? { fallbackUsed: true } : {}),
      stages: snapshot.stageDurations,
    };
  }

  log(logger = this.logger): DocumentIngestionTimingLogEntry {
    const entry = this.toLogEntry();
    logger?.(entry);
    return entry;
  }

  serverTiming(): string {
    return formatServerTiming(this);
  }

  serverTimingHeader(existing?: string | null): string {
    return mergeServerTimingHeader(existing, this);
  }
}

export function createDocumentIngestionTiming(
  metadata: DocumentIngestionTimingMetadata = {},
  options: DocumentIngestionTimingOptions = {},
): DocumentIngestionTiming {
  return new DocumentIngestionTiming(metadata, options);
}

export function createSafeDocumentIngestionLogEntry(
  timing: DocumentIngestionTiming | DocumentIngestionTimingSnapshot,
): DocumentIngestionTimingLogEntry {
  if (timing instanceof DocumentIngestionTiming) return timing.toLogEntry();
  const documentType = safeDocumentType(timing.documentType);
  const byteSize = safeNonNegativeInteger(timing.byteSize);
  const pageCount = safeNonNegativeInteger(timing.pageCount);
  const ocrPageCount = safeNonNegativeInteger(timing.ocrPageCount);
  const cacheStatus = safeCacheStatus(timing.cacheStatus);
  const stages = Object.fromEntries(stageEntries(timing)) as Partial<Record<DocumentIngestionStage, number>>;
  const failedStages = timing.failedStages.filter((stage) => STAGE_SET.has(stage));
  const failedStage = failedStages.at(-1) ?? null;
  return {
    event: "document-ingestion-timing",
    documentType,
    byteSize,
    pageCount,
    ocrPageCount,
    cacheStatus,
    durationMs: safeDuration(timing.durationMs),
    failedStage,
    failedStages,
    ...(timing.fallbackUsed === true ? { fallbackUsed: true } : {}),
    stages,
  };
}

export function logDocumentIngestionTiming(
  timing: DocumentIngestionTiming | DocumentIngestionTimingSnapshot,
  logger: DocumentIngestionTimingLogger,
): DocumentIngestionTimingLogEntry {
  const entry = createSafeDocumentIngestionLogEntry(timing);
  logger(entry);
  return entry;
}

export function formatServerTiming(source: ServerTimingSource): string {
  const durations = new Map(stageEntries(source));
  return DOCUMENT_INGESTION_STAGE_ORDER
    .filter((stage) => durations.has(stage))
    .map((stage) => `${stage};dur=${formatDuration(durations.get(stage) ?? 0)}`)
    .join(", ");
}

function formatDuration(durationMs: number): string {
  return safeDuration(durationMs).toString();
}

export function mergeServerTimingHeader(
  existing: string | null | undefined,
  source: ServerTimingSource | string,
): string {
  const addition = typeof source === "string" ? source.trim() : formatServerTiming(source);
  const prior = existing?.trim() ?? "";
  if (!prior) return addition;
  if (!addition) return prior;
  return `${prior}, ${addition}`;
}

export function mergeServerTimingHeaders(
  headers: HeadersInit,
  source: ServerTimingSource | string,
): Headers {
  const merged = new Headers(headers);
  const value = mergeServerTimingHeader(merged.get("Server-Timing"), source);
  if (value) merged.set("Server-Timing", value);
  return merged;
}
