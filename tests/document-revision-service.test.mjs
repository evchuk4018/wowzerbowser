import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parsePdfNatively } from "../app/server/chat/pdf-native-parser.ts";
test("revision validation can open and count a produced PDF", async () => {
  const bytes = await readFile(new URL("./fixtures/documents/multi-page-text.pdf", import.meta.url));
  const pdf = await parsePdfNatively(bytes);
  assert.ok(pdf.pageCount > 0);
});

