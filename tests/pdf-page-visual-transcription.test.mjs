import assert from "node:assert/strict";
import test from "node:test";
import { transcribeRenderedPdfPage } from "../app/server/chat/pdf-page-visual-transcription.ts";

const page = { pageNumber: 3, bytes: new Uint8Array([1, 2, 3]), contentType: "image/png", width: 800, height: 1_000 };
const request = { ownerId: "owner", conversationId: "conversation", jobId: "job", requestId: "request", page, question: "Transcribe integral questions." };

test("structured PDF visual transcription preserves formulas and records usage", async () => {
  let inspected;
  let usage;
  const result = await transcribeRenderedPdfPage(request, {
    configuredVisionModel: async () => "vision-test",
    askOpenRouterAboutImage: async (prompt, bytes, contentType, options) => {
      inspected = { prompt, bytes, contentType, options };
      return {
        content: JSON.stringify({
          transcription: "Q3 — Evaluate \\(4se^s\\) \\[ ds.",
          questions: [{ label: "Q3", text: "Evaluate \\(4se^s\\) \\[ ds.", formulas: ["\\int 4se^s\\,ds"], confidence: "high", uncertainty: null }],
        }),
        model: "vision-test",
        usage: { promptTokens: 20, completionTokens: 12, totalTokens: 32 },
      };
    },
    recordPromptUsage: async (input) => { usage = input; return null; },
  });

  assert.equal(result.pageNumber, 3);
  assert.equal(result.questions[0].formulas[0], "\\int 4se^s\\,ds");
  assert.deepEqual(inspected.bytes, page.bytes);
  assert.equal(inspected.contentType, "image/png");
  assert.equal(inspected.options.model, "vision-test");
  assert.equal(inspected.options.responseFormat.json_schema.name, "pdf_page_transcription");
  assert.match(inspected.prompt, /vector-rendered mathematical notation/);
  assert.equal(usage.requestKind, "image_followup");
  assert.equal(usage.requestId, "request");
});

test("structured PDF visual transcription rejects guessed or malformed response shapes", async () => {
  await assert.rejects(
    transcribeRenderedPdfPage(request, {
      configuredVisionModel: async () => null,
      askOpenRouterAboutImage: async () => ({ content: "not json", model: null, usage: null }),
      recordPromptUsage: async () => null,
    }),
    /invalid structured data/i,
  );
  await assert.rejects(
    transcribeRenderedPdfPage(request, {
      configuredVisionModel: async () => null,
      askOpenRouterAboutImage: async () => ({ content: JSON.stringify({ transcription: "", questions: [] }), model: null, usage: null }),
      recordPromptUsage: async () => null,
    }),
    /omitted required fields/i,
  );
});
