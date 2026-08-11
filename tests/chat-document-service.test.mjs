import assert from "node:assert/strict";
import test from "node:test";

import { createPdfIngestor } from "../app/server/chat/chat-document-service.ts";
import { DocumentIngestionTiming } from "../app/server/chat/document-ingestion-timing.ts";

const objectId = "11111111-1111-4111-8111-111111111111";
const imageObjectId = "22222222-2222-4222-8222-222222222222";
const storedObject = {
  objectId,
  ownerId: "owner",
  conversationId: "conversation",
  documentId: "document",
  messageId: null,
  projectId: null,
  revisionId: null,
  kind: "document",
  objectKey: `objects/${objectId}`,
  originalFilename: "document.pdf",
  contentType: "application/pdf",
  size: 5,
  sha256: "a".repeat(64),
  state: "complete",
  createdAt: new Date().toISOString(),
  completedAt: new Date().toISOString(),
};

function documentInput(overrides = {}) {
  return {
    ownerId: "owner",
    conversationId: "conversation",
    pdfId: "document",
    filename: "document.pdf",
    bytes: new Uint8Array([37, 80, 68, 70, 45]),
    userMessageId: "message",
    jobId: "job",
    timing: new DocumentIngestionTiming({ documentType: "application/pdf", byteSize: 5 }),
    ...overrides,
  };
}

function odlOutput() {
  return {
    filename: "document.pdf",
    json: {
      "file name": "input.pdf",
      "number of pages": 2,
      author: null,
      title: null,
      "creation date": null,
      "modification date": null,
      kids: [
        { type: "heading", id: 1, "page number": 1, "bounding box": [0, 0, 100, 20], "heading level": 1, content: "Report" },
        { type: "image", id: 2, "page number": 1, "bounding box": [0, 20, 100, 100], source: "images/imageFile1.png", format: "png" },
        { type: "paragraph", id: 3, "page number": 2, "bounding box": [0, 0, 100, 20], content: "Second page" },
      ],
    },
    markdown: "# Report\n\n![image](images/imageFile1.png)\n\n<!-- WOWZERBOWSER_ODL_PAGE_2 -->\n\nSecond page",
    images: [{ source: "images/imageFile1.png", format: "png", bytes: new Uint8Array([137, 80, 78, 71]) }],
  };
}

function preparedImage() {
  return {
    imageId: "image-1",
    pageNumber: 1,
    storageObjectId: imageObjectId,
    storagePath: `objects/${imageObjectId}`,
    contentType: "image/png",
    providerMetadata: {
      source: "images/imageFile1.png",
      analysisStatus: "complete",
      analysis: { visibleText: "Figure text", mainVisuals: "A simple figure." },
    },
  };
}

test("PDF ingestion uses only OpenDataLoader and registers Markdown, text, and image analysis", async () => {
  let registered;
  let prepared;
  const calls = [];
  const ingestPdf = createPdfIngestor({
    convertPdfWithOpenDataLoader: async () => { calls.push("opendataloader"); return odlOutput(); },
    prepareDocumentImages: async (input) => { calls.push("image-pipeline"); prepared = input; return [preparedImage()]; },
    getStorageObjectById: async () => { calls.push("storage-read"); return storedObject; },
    registerDocument: async (input) => { calls.push("register"); registered = input; },
  });

  const result = await ingestPdf(documentInput({ alreadyUploaded: true, storageObjectId: objectId }));

  assert.deepEqual(calls, ["opendataloader", "storage-read", "image-pipeline", "register"]);
  assert.equal(prepared.candidates.length, 1);
  assert.equal(result.pageCount, 2);
  assert.equal(result.imageCount, 1);
  assert.equal(result.analyzedImageCount, 1);
  assert.equal(registered.pages[0].text, "Report");
   assert.match(registered.pages[0].markdown, /\/api\/chat\/documents\/document\/images\/image-1\?conversationId=conversation/);
  assert.match(registered.pages[0].markdown, /A simple figure/);
  assert.equal(registered.pages[1].text, "Second page");
  assert.equal(registered.pages[0].extractionMethod, "opendataloader");
  assert.equal(registered.document.providerMetadata.provider, "opendataloader");
});

test("OpenDataLoader failures do not invoke a legacy parser or register a partial document", async () => {
  let registerCalls = 0;
  const ingestPdf = createPdfIngestor({
    convertPdfWithOpenDataLoader: async () => { throw new Error("ODL unavailable"); },
    prepareDocumentImages: async () => [],
    getStorageObjectById: async () => storedObject,
    registerDocument: async () => { registerCalls += 1; },
  });

  await assert.rejects(ingestPdf(documentInput({ alreadyUploaded: true, storageObjectId: objectId })), /ODL unavailable/);
  assert.equal(registerCalls, 0);
});

test("PDF image candidates can be recovered from Markdown when JSON omits the image source", async () => {
  let registered;
  const output = odlOutput();
  output.json.kids[1] = { type: "image", id: 2, "page number": 1, "bounding box": [0, 20, 100, 100] };
  const ingestPdf = createPdfIngestor({
    convertPdfWithOpenDataLoader: async () => output,
    prepareDocumentImages: async (input) => input.candidates.map(() => preparedImage()),
    getStorageObjectById: async () => storedObject,
    registerDocument: async (input) => { registered = input; },
  });

  await ingestPdf(documentInput({ alreadyUploaded: true, storageObjectId: objectId }));

  assert.match(registered.pages[0].markdown, /\/api\/chat\/documents\/document\/images\/image-1/);
});

test("PDF page metadata flags math context when visible content has no native formula", async () => {
  let registered;
  const output = odlOutput();
  output.json.kids[0].content = "Evaluate the integral:";
  const ingestPdf = createPdfIngestor({
    convertPdfWithOpenDataLoader: async () => output,
    prepareDocumentImages: async () => [],
    getStorageObjectById: async () => storedObject,
    registerDocument: async (input) => { registered = input; },
  });

  await ingestPdf(documentInput({ alreadyUploaded: true, storageObjectId: objectId }));

  assert.equal(registered.pages[0].providerMetadata.mathDiagnostics.likelyMissingMath, true);
  assert.ok(registered.pages[0].providerMetadata.mathDiagnostics.reasons.includes("math_context_without_native_formula"));
  assert.match(registered.pages[0].markdown, /PDF extraction warning/);
});
