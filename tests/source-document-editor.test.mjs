import test from "node:test";
import assert from "node:assert/strict";
import { applyUnifiedDiff, replaceText } from "../app/server/documents/source-document-editor.ts";

test("source replacement enforces exact occurrence counts", () => {
  assert.equal(replaceText("a b a", { type: "replace_text", path: "main.py", oldText: "a", newText: "x", expectedOccurrences: 2 }), "x b x");
  assert.throws(() => replaceText("a", { type: "replace_text", path: "main.py", oldText: "a", newText: "x", expectedOccurrences: 2 }), /Expected 2 occurrences/);
});
test("unified diff rejects mismatched context", () => {
  assert.equal(applyUnifiedDiff("one\ntwo", "@@ -1,2 +1,2 @@\n-one\n+uno\n two"), "uno\ntwo");
  assert.throws(() => applyUnifiedDiff("one", "@@ -1,1 +1,1 @@\n-two\n+dos"), /does not match/);
});

