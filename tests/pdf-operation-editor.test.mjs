import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { validateOperations } from "../app/server/documents/pdf-operation-editor.ts";
import { PDF_OPERATION_SCRIPT } from "../app/server/documents/pdf-operation-script.mjs";

const inspection = { pageCount: 2, pages: [{ pageNumber: 1, width: 600, height: 800, nativeTextCharacters: 10, imageCount: 0, likelyScanned: false, rotation: 0 }, { pageNumber: 2, width: 600, height: 800, nativeTextCharacters: 10, imageCount: 0, likelyScanned: false, rotation: 0 }] };

function runPython(code, stdin = "", args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn("python", ["-c", code, ...args], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

test("PDF operation validation tracks page state", () => {
  assert.doesNotThrow(() => validateOperations([{ type: "delete_pages", pages: [2] }, { type: "insert_blank_page", afterPage: 1 }], inspection));
  assert.throws(() => validateOperations([{ type: "delete_pages", pages: [1, 2] }], inspection), /every page/);
  assert.throws(() => validateOperations([{ type: "add_text", page: 1, x: 590, y: 0, width: 20, height: 20, text: "x", fontSize: 10 }], inspection), /outside/);
});

test("PDF operation validation covers text, overlays, watermarks, and form fields", () => {
  assert.doesNotThrow(() => validateOperations([
    { type: "replace_text", query: "before", replacement: "after", expectedOccurrences: 1 },
    { type: "redact_text", query: "secret", pages: [1], expectedOccurrences: 1 },
    { type: "add_text", page: 1, x: 10, y: 10, width: 100, height: 20, text: "note", fontSize: 10 },
    { type: "watermark", text: "draft", opacity: 0.25 },
    { type: "set_form_field", fieldName: "customer", value: "Ada" },
  ], inspection));
  assert.throws(() => validateOperations([{ type: "set_form_field", fieldName: " ", value: "Ada" }], inspection), /Form field/);
  assert.throws(() => validateOperations([{ type: "set_form_field", fieldName: "customer", value: "x".repeat(16_385) }], inspection), /Form field/);
});

test("production PDF operation source compiles as Python", async () => {
  assert.match(PDF_OPERATION_SCRIPT, /\nfrom pypdf import PdfReader\n/);
  assert.doesNotMatch(PDF_OPERATION_SCRIPT, /\\n/);
  const result = await runPython(
    "import sys; compile(sys.stdin.read(), '<pdf-operation-script>', 'exec')",
    PDF_OPERATION_SCRIPT,
  );
  assert.equal(result.exitCode, 0, result.stderr);
});

const formHarness = [
  "import io, json, sys, types",
  "envelope = json.loads(sys.stdin.read())",
  "class Widget:",
  "    def __init__(self, name):",
  "        self.field_name = name",
  "        self.field_value = ''",
  "        self.updated = False",
  "    def update(self):",
  "        self.updated = True",
  "class Page:",
  "    def __init__(self):",
  "        self._widgets = [Widget(envelope['availableField'])]",
  "    def widgets(self):",
  "        return self._widgets",
  "class Document:",
  "    def __init__(self):",
  "        self.pages = [Page()]",
  "    def __len__(self):",
  "        return len(self.pages)",
  "    def __getitem__(self, index):",
  "        return self.pages[index]",
  "    def save(self, *args, **kwargs):",
  "        pass",
  "    def close(self):",
  "        pass",
  "fitz = types.ModuleType('fitz')",
  "fitz.open = lambda path: Document()",
  "fitz.Rect = lambda *args: args",
  "pypdf = types.ModuleType('pypdf')",
  "pypdf.PdfReader = lambda path: types.SimpleNamespace(pages=[object()])",
  "sys.modules['fitz'] = fitz",
  "sys.modules['pypdf'] = pypdf",
  "sys.argv = ['pdf-operation-script', 'input.pdf', 'output.pdf']",
  "sys.stdin = io.StringIO(json.dumps(envelope['payload']))",
  "exec(compile(envelope['script'], '<pdf-operation-script>', 'exec'))",
].join("\n");

test("form-field edits update matching widgets and report missing fields", async () => {
  const payload = (fieldName) => JSON.stringify({
    script: PDF_OPERATION_SCRIPT,
    availableField: "customer",
    payload: {
      operations: [{ type: "set_form_field", fieldName, value: "Ada" }],
      documents: {},
      images: {},
    },
  });
  const success = await runPython(formHarness, payload("customer"));
  assert.equal(success.exitCode, 0, success.stderr);
  assert.deepEqual(JSON.parse(success.stdout.trim()), { changedPages: [1], warnings: [] });

  const missing = await runPython(formHarness, payload("missing"));
  assert.notEqual(missing.exitCode, 0);
  assert.match(missing.stderr, /No form field named 'missing' was found/);
});
