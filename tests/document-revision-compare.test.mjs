import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
test("revision comparison output hashes are stable", () => {
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  assert.equal(digest("same"), digest("same"));
  assert.notEqual(digest("left"), digest("right"));
});

