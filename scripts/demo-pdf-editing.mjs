import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDF_OPERATION_SCRIPT } from "../app/server/documents/pdf-operation-script.mjs";

function runPython(code, args = [], stdin = "") {
  return new Promise((resolve, reject) => {
    const child = spawn("python", ["-c", code, ...args], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr || stdout || `Python exited with code ${exitCode}.`));
    });
    child.stdin.end(stdin);
  });
}

const createFixture = [
  "import hashlib, os, sys",
  "from reportlab.pdfgen import canvas",
  "root = sys.argv[1]",
  "output = os.path.join(root, 'original.pdf')",
  "document = canvas.Canvas(output)",
  "document.drawString(72, 760, 'Original Title')",
  "document.acroForm.textfield(name='customer', x=72, y=700, width=180, height=24)",
  "document.showPage()",
  "document.drawString(72, 760, 'Invoice 1001')",
  "document.showPage()",
  "document.drawString(72, 760, 'Third page')",
  "document.save()",
  "print(hashlib.sha256(open(output, 'rb').read()).hexdigest())",
].join("\n");

const verifyOutput = [
  "import hashlib, json, os, sys",
  "import fitz",
  "root, original_hash = sys.argv[1:3]",
  "original = os.path.join(root, 'original.pdf')",
  "edited = os.path.join(root, 'edited.pdf')",
  "document = fitz.open(edited)",
  "text = ''.join(page.get_text() for page in document)",
  "fields = [widget for page in document for widget in (page.widgets() or [])]",
  "assert len(document) == 2, {'pages': len(document)}",
  "assert 'Edited Title' in text and 'Overlay Note' in text, {'text': text}",
  "assert document[1].rotation == 90, {'rotation': document[1].rotation}",
  "assert any(widget.field_name == 'customer' and widget.field_value == 'Ada' for widget in fields), {'fields': [(widget.field_name, widget.field_value) for widget in fields]}",
  "document.close()",
  "assert hashlib.sha256(open(original, 'rb').read()).hexdigest() == original_hash",
  "print(json.dumps({'pages': 2, 'formUpdated': True, 'originalUnchanged': True}))",
].join("\n");

const directory = await mkdtemp(join(tmpdir(), "wowzerbowser-pdf-demo-"));
try {
  const fixture = await runPython(createFixture, [directory]);
  const originalPath = join(directory, "original.pdf");
  const editedPath = join(directory, "edited.pdf");
  const operations = [
    { type: "replace_text", query: "Original Title", replacement: "Edited Title", expectedOccurrences: 1 },
    { type: "add_text", page: 1, x: 72, y: 640, width: 180, height: 24, text: "Overlay Note", fontSize: 11 },
    { type: "set_form_field", fieldName: "customer", value: "Ada" },
    { type: "delete_pages", pages: [2] },
    { type: "rotate_pages", pages: [2], degrees: 90 },
  ];
  await runPython(
    PDF_OPERATION_SCRIPT,
    [originalPath, editedPath],
    JSON.stringify({ operations, documents: {}, images: {} }),
  );
  const result = await runPython(verifyOutput, [directory, fixture.stdout.trim()]);
  console.log(result.stdout.trim());
} catch (error) {
  console.error(error instanceof Error ? error.message : "PDF demo failed.");
  process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
