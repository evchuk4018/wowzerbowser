import assert from "node:assert/strict";
import test from "node:test";
import { parseCitationMarkup, sourceForUrl, stableSourceId } from "../lib/chat-citations.ts";

test("source ids are stable across equivalent URLs", () => {
  assert.equal(stableSourceId("https://Example.com/story/#top"), stableSourceId("https://example.com/story"));
});

test("citation markup becomes clean content with multiple supporting sources", () => {
  const first = sourceForUrl({ url: "https://example.com/one", title: "One" });
  const second = sourceForUrl({ url: "https://example.com/two", title: "Two" });
  const parsed = parseCitationMarkup(`Claim.⟦cite:${first.id},${second.id}⟧ Next.`, [first, second]);
  assert.equal(parsed.content, "Claim. Next.");
  assert.deepEqual(parsed.annotations, [{ start: 0, end: 6, sourceIds: [first.id, second.id] }]);
  assert.doesNotMatch(parsed.content, /cite:|src_/);
});

test("unknown and malformed source references are removed without annotations", () => {
  const source = sourceForUrl({ url: "https://example.com/one", title: "One" });
  const parsed = parseCitationMarkup(`A⟦cite:src_missing⟧ B⟦cite:not-a-source⟧ C`, [source]);
  assert.equal(parsed.content, "A B C");
  assert.deepEqual(parsed.annotations, []);
});
