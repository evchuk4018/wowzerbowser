import assert from "node:assert/strict";
import test from "node:test";
import { linkedPdfArtifact } from "../app/chat/artifact-links.ts";

const pdf = {
  id: "signed-artifact-id",
  name: "short_story.pdf",
  contentType: "application/pdf",
  size: 42,
};

test("matches generated PDF links by sandbox path or visible filename", () => {
  assert.equal(linkedPdfArtifact("sandbox:/mnt/data/short_story.pdf", "short_story.pdf", [pdf]), pdf);
  assert.equal(linkedPdfArtifact("./downloads/short_story.pdf?download=1", "Download", [pdf]), pdf);
  assert.equal(linkedPdfArtifact(undefined, "short_story.pdf", [pdf]), pdf);
});

test("does not intercept external links or non-PDF artifacts", () => {
  assert.equal(linkedPdfArtifact("https://example.com/short_story.pdf", "short_story.pdf", [pdf]), undefined);
  assert.equal(
    linkedPdfArtifact("notes.txt", "notes.txt", [{ ...pdf, name: "notes.txt", contentType: "text/plain" }]),
    undefined,
  );
});
