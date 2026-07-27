import test from "node:test";
import assert from "node:assert/strict";
import { validateOperations } from "../app/server/documents/pdf-operation-editor.ts";
const inspection = { pageCount: 2, pages: [{ pageNumber: 1, width: 600, height: 800, nativeTextCharacters: 10, imageCount: 0, likelyScanned: false, rotation: 0 }, { pageNumber: 2, width: 600, height: 800, nativeTextCharacters: 10, imageCount: 0, likelyScanned: false, rotation: 0 }] };
test("PDF operation validation tracks page state", () => {
  assert.doesNotThrow(() => validateOperations([{ type: "delete_pages", pages: [2] }, { type: "insert_blank_page", afterPage: 1 }], inspection));
  assert.throws(() => validateOperations([{ type: "delete_pages", pages: [1, 2] }], inspection), /every page/);
  assert.throws(() => validateOperations([{ type: "add_text", page: 1, x: 590, y: 0, width: 20, height: 20, text: "x", fontSize: 10 }], inspection), /outside/);
});

