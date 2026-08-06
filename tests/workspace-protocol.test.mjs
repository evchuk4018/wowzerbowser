import assert from "node:assert/strict";
import test from "node:test";
import {
  workspaceContentType,
  workspaceFileFor,
  workspaceLanguage,
  workspacePath,
  workspacePreview,
} from "../lib/workspace-protocol.ts";

test("workspace metadata covers common code and document formats", () => {
  assert.equal(workspaceLanguage("index.html"), "html");
  assert.equal(workspaceContentType("app.tsx"), "text/typescript; charset=utf-8");
  assert.equal(workspacePreview("README.md"), "markdown");
  assert.equal(workspacePreview("icon.svg"), "svg");
  assert.deepEqual(workspaceFileFor("src/app.py", 12, "a".repeat(64)), {
    path: "src/app.py",
    name: "app.py",
    size: 12,
    contentType: "text/x-python; charset=utf-8",
    language: "python",
    editable: true,
    preview: "text",
    sha256: "a".repeat(64),
  });
});

test("workspace root is valid only for directory operations", () => {
  assert.equal(workspacePath("."), "");
  assert.equal(workspacePath("./src"), "src");
  assert.throws(() => workspacePath("../secret"), /safe relative path/);
  assert.throws(() => workspacePath(".venv/bin/python"), /reserved workspace directory/);
});
