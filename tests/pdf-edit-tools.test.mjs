import test from "node:test";
import assert from "node:assert/strict";
import { availablePdfEditTools, PDF_EDIT_TOOL_DEFINITIONS } from "../app/server/agent/pdf-edit-tool-manifest.ts";
test("PDF edit tools are separate and gated by authorized PDFs", () => {
  assert.equal(availablePdfEditTools(false).length, 0);
  assert.equal(availablePdfEditTools(true).length, 4);
  assert.deepEqual(PDF_EDIT_TOOL_DEFINITIONS.map((tool) => tool.function.name), ["inspect_pdf_editability", "edit_source_backed_document", "edit_pdf", "compare_document_revisions"]);
});

