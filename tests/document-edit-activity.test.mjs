import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
test("document activity exposes the required status labels", async () => {
  const source = await readFile(new URL("../app/chat/document-edit-activity.tsx", import.meta.url), "utf8");
  assert.match(source, /Inspecting PDF/);
  assert.match(source, /Applying PDF edits/);
  assert.match(source, /changedPages/);
});

