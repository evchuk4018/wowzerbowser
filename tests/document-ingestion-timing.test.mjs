import test from "node:test";
import assert from "node:assert/strict";
import {
  DOCUMENT_INGESTION_STAGES,
  DocumentIngestionTiming,
  createSafeDocumentIngestionLogEntry,
  formatServerTiming,
  mergeServerTimingHeader,
  mergeServerTimingHeaders,
} from "../app/server/chat/document-ingestion-timing.ts";

function clock() {
  let value = 1_000;
  return {
    now: () => value,
    advance: (milliseconds) => { value += milliseconds; },
  };
}

test("records stable stages, aggregates repeated work, and identifies failures", async () => {
  const time = clock();
  const timing = new DocumentIngestionTiming({ documentType: "application/pdf", byteSize: 4_096, cacheStatus: "miss" }, { now: time.now });

  time.advance(7);
  await timing.measure(DOCUMENT_INGESTION_STAGES.EXTERNAL_PARSING, async () => {
    time.advance(13);
  });
  time.advance(2);
  await assert.rejects(
    timing.measure(DOCUMENT_INGESTION_STAGES.OCR, async () => {
      time.advance(11);
      throw new Error("provider details must not be logged");
    }),
  );
  time.advance(3);
  timing.recordStage(DOCUMENT_INGESTION_STAGES.OCR, 4);
  const snapshot = timing.finish();

  assert.equal(snapshot.stageDurations[DOCUMENT_INGESTION_STAGES.EXTERNAL_PARSING], 13);
  assert.equal(snapshot.stageDurations[DOCUMENT_INGESTION_STAGES.OCR], 15);
  assert.equal(snapshot.stages.find((stage) => stage.stage === DOCUMENT_INGESTION_STAGES.OCR)?.status, "failed");
  assert.equal(snapshot.failedStage, DOCUMENT_INGESTION_STAGES.OCR);
  assert.deepEqual(snapshot.failedStages, [DOCUMENT_INGESTION_STAGES.OCR]);
  assert.equal(snapshot.stageDurations[DOCUMENT_INGESTION_STAGES.TOTAL_PREPARATION], 36);
  assert.equal(snapshot.completed, true);
});

test("formats and merges Server-Timing metrics in stable order", () => {
  const metrics = {
    [DOCUMENT_INGESTION_STAGES.OCR]: 3.456,
    [DOCUMENT_INGESTION_STAGES.NATIVE_PARSING]: 12,
  };
  assert.equal(
    formatServerTiming(metrics),
    "native-parsing;dur=12, ocr;dur=3.46",
  );
  assert.equal(
    mergeServerTimingHeader("cache;desc=\"hit\"", metrics),
    "cache;desc=\"hit\", native-parsing;dur=12, ocr;dur=3.46",
  );

  const headers = mergeServerTimingHeaders({ "Server-Timing": "prior;dur=1" }, metrics);
  assert.equal(headers.get("Server-Timing"), "prior;dur=1, native-parsing;dur=12, ocr;dur=3.46");
});

test("structured logging keeps only bounded, safe metadata and never includes error details", () => {
  const time = clock();
  const timing = new DocumentIngestionTiming({
    documentType: "application/pdf\nsecret-path=/private/file.pdf",
    byteSize: -1,
    pageCount: Number.POSITIVE_INFINITY,
    ocrPageCount: 2,
    cacheStatus: "cached-by-attacker\nsecret",
  }, { now: time.now });
  timing.markFailed(DOCUMENT_INGESTION_STAGES.SUPABASE_DOWNLOAD, 9);
  const entry = timing.toLogEntry();
  const serialized = JSON.stringify(entry);

  assert.deepEqual(entry, {
    event: "document-ingestion-timing",
    documentType: "unknown",
    byteSize: null,
    pageCount: null,
    ocrPageCount: 2,
    cacheStatus: "unknown",
    durationMs: 0,
    failedStage: DOCUMENT_INGESTION_STAGES.SUPABASE_DOWNLOAD,
    failedStages: [DOCUMENT_INGESTION_STAGES.SUPABASE_DOWNLOAD],
    stages: { [DOCUMENT_INGESTION_STAGES.SUPABASE_DOWNLOAD]: 9 },
  });
  assert.doesNotMatch(serialized, /secret|private|provider details|file\.pdf/);

  const safeSnapshot = createSafeDocumentIngestionLogEntry({
    ...timing.snapshot(),
    documentType: "docx\r\nforged=1",
    failedStages: [DOCUMENT_INGESTION_STAGES.OCR, "not-a-stage"],
  });
  assert.equal(safeSnapshot.documentType, "unknown");
  assert.deepEqual(safeSnapshot.failedStages, [DOCUMENT_INGESTION_STAGES.OCR]);
});
