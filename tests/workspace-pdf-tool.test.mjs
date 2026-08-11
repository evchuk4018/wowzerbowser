import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { executeInspectWorkspacePdfTool } from "../app/server/agent/workspace-pdf-tool.ts";
import { INSPECT_WORKSPACE_PDF_TOOL_NAME } from "../app/server/agent/workspace-pdf-tool-manifest.ts";

const bytes = await readFile(new URL("./fixtures/documents/text-layer.pdf", import.meta.url));
const call = (args) => ({ id: "pdf-call", name: INSPECT_WORKSPACE_PDF_TOOL_NAME, arguments: JSON.stringify(args) });
const context = {
  ownerId: "owner",
  conversationId: "conversation",
  jobId: "job",
  signal: AbortSignal.timeout(10_000),
  responseDeadlineAt: Date.now() + 10_000,
  executor: { readWorkspaceFile: async (path) => { assert.equal(path, "Firefox.pdf"); return bytes; } },
};

test("workspace PDF inspection renders selected pages and returns ordered structured results", async () => {
  const seen = [];
  const result = await executeInspectWorkspacePdfTool(call({ path: "Firefox.pdf", pageNumbers: [1], question: "Transcribe every visible equation." }), context, {
    transcribeRenderedPdfPage: async (input) => {
      seen.push(input);
      return { pageNumber: input.page.pageNumber, transcription: "Q1 \\(x^2\\).", questions: [{ label: "Q1", text: "Q1 \\(x^2\\).", formulas: ["x^2"], confidence: "high", uncertainty: null }], model: "vision-test" };
    },
  });

  assert.equal(result.ok, true);
  const output = JSON.parse(result.stdout);
  assert.equal(output.path, "Firefox.pdf");
  assert.equal(output.pages[0].pageNumber, 1);
  assert.equal(output.pages[0].questions[0].formulas[0], "x^2");
  assert.equal(seen.length, 1);
  assert.match(seen[0].question, /visible equation/);
});
test("workspace PDF inspection rejects non-PDF paths before reading", async () => {
  let read = false;
  const result = await executeInspectWorkspacePdfTool(call({ path: "Firefox.png", pageNumbers: [1], question: "Transcribe it." }), {
    ...context,
    executor: { readWorkspaceFile: async () => { read = true; throw new Error("should not read"); } },
  });
  assert.equal(result.ok, false);
  assert.match(result.stderr, /PDF workspace file/i);
  assert.equal(read, false);
});
