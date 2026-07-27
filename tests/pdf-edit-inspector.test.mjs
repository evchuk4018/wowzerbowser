import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parsePdfNatively } from "../app/server/chat/pdf-native-parser.ts";

test("inspector inputs expose scan-relevant native PDF facts", async () => {
  const bytes = await readFile(new URL("./fixtures/documents/text-layer.pdf", import.meta.url));
  const result = await parsePdfNatively(bytes);
  assert.ok(result.pageCount > 0);
  assert.ok(result.pages.every((page) => page.pageWidth > 0 && page.pageHeight > 0));
  assert.equal(result.pages.length, result.pageCount);
});

