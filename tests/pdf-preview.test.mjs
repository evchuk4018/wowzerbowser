import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  PDF_PREVIEW_MIN_COLUMN_WIDTH,
  clampPdfPreviewWidth,
  defaultPdfPreviewWidth,
  resolvePdfArtifact,
  usesFullscreenPdfPreview,
} from "../app/chat/pdf-preview-layout.ts";

const pdf = (id, name) => ({
  id,
  name,
  contentType: "application/pdf",
  size: 10,
});

test("resolves generated PDF links against authenticated response artifacts", () => {
  const story = pdf("story", "short_story.pdf");
  const notes = {
    id: "notes",
    name: "notes.txt",
    contentType: "text/plain",
    size: 4,
  };

  assert.equal(
    resolvePdfArtifact("sandbox:/mnt/data/short_story.pdf", "short_story.pdf", [story]),
    story,
  );
  assert.equal(
    resolvePdfArtifact("sandbox:/mnt/data/My%20Story.pdf", "Download", [pdf("my-story", "My Story.pdf")])?.id,
    "my-story",
  );
  assert.equal(resolvePdfArtifact("", "short_story.pdf", [story]), story);
  assert.equal(resolvePdfArtifact("https://example.com/report", "Report", [story]), null);
  assert.equal(resolvePdfArtifact("sandbox:/mnt/data/notes.txt", "notes.txt", [notes]), null);
});

test("uses the only PDF for a PDF reference but rejects ambiguous filenames", () => {
  const onlyPdf = pdf("only", "generated_name.pdf");
  assert.equal(
    resolvePdfArtifact("sandbox:/mnt/data/story.pdf", "story.pdf", [onlyPdf]),
    onlyPdf,
  );
  assert.equal(
    resolvePdfArtifact("sandbox:/mnt/data/story.pdf", "story.pdf", [
      pdf("one", "story.pdf"),
      pdf("two", "story.pdf"),
    ]),
    null,
  );
});

test("calculates a balanced preview and preserves both desktop columns", () => {
  assert.equal(usesFullscreenPdfPreview(1019), true);
  assert.equal(usesFullscreenPdfPreview(1020), false);
  assert.equal(defaultPdfPreviewWidth(1200), 450);
  assert.equal(clampPdfPreviewWidth(100, 1200), PDF_PREVIEW_MIN_COLUMN_WIDTH);
  assert.equal(clampPdfPreviewWidth(900, 1200), 540);
});

test("wires the PDF preview through the workspace and responsive shell", async () => {
  const [workspace, panel, response, activity, styles] = await Promise.all([
    readFile(new URL("../app/chat/chat-workspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/chat/pdf-preview-panel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/chat/assistant-response.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/chat/assistant-activity.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/styles/pdf-preview.css", import.meta.url), "utf8"),
  ]);

  assert.match(workspace, /fetchChatArtifact\(artifact\)/);
  assert.match(workspace, /URL\.createObjectURL\(blob\)/);
  assert.match(workspace, /URL\.revokeObjectURL/);
  assert.match(workspace, /onOpenArtifact=\{openPdfPreview\}/);
  assert.match(panel, /role="separator"/);
  assert.match(panel, /ArrowLeft/);
  assert.match(panel, /aria-label="Close PDF preview"/);
  assert.match(panel, /<iframe/);
  assert.match(panel, /Try again/);
  assert.match(response, /resolvePdfArtifact/);
  assert.match(response, /className="artifact-inline-pdf"/);
  assert.match(activity, /isPdf \? onOpenArtifact\(artifact\)/);
  assert.match(styles, /grid-template-columns:[\s\S]*?minmax\(360px, 1fr\)/);
  assert.match(styles, /@media \(max-width: 1019px\)/);
  assert.match(styles, /\.pdf-preview-panel[\s\S]*?position: fixed/);
});
