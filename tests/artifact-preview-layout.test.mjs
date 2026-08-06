import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ARTIFACT_PREVIEW_MIN_COLUMN_WIDTH,
  clampArtifactPreviewWidth,
  defaultArtifactPreviewWidth,
  usesFullscreenArtifactPreview,
} from "../app/chat/artifact-preview-layout.ts";

test("balances artifact preview columns and uses fullscreen below the desktop threshold", () => {
  assert.equal(usesFullscreenArtifactPreview(1019), true);
  assert.equal(usesFullscreenArtifactPreview(1020), false);
  assert.equal(defaultArtifactPreviewWidth(1200), 450);
  assert.equal(clampArtifactPreviewWidth(100, 1200), ARTIFACT_PREVIEW_MIN_COLUMN_WIDTH);
  assert.equal(clampArtifactPreviewWidth(900, 1200), 540);
});

test("artifact panel exposes editing actions, states, accessible resizing, and safe preview", async () => {
  const [panel, styles] = await Promise.all([
    readFile(new URL("../app/chat/artifact-preview-panel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/styles/artifact-preview.css", import.meta.url), "utf8"),
  ]);

  assert.match(panel, /type ArtifactPreviewPanelProps/);
  assert.match(panel, /role="separator"/);
  assert.match(panel, /ArrowLeft/);
  assert.match(panel, /role="tablist"/);
  assert.match(panel, /<textarea/);
  assert.match(panel, /sandbox=""/);
  assert.match(panel, /navigator\.clipboard\.writeText/);
  assert.match(panel, /URL\.createObjectURL/);
  assert.match(panel, /Save failed/);
  assert.match(panel, /loadState === "loading"/);
  assert.match(panel, /loadState === "error"/);
  assert.match(styles, /@media \(max-width: 1019px\)/);
  assert.match(styles, /artifact-preview-fullscreen-compatible/);
});
