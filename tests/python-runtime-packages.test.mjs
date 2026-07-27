import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  PYTHON_RUNTIME_PACKAGE_CATALOG,
  PYTHON_RUNTIME_PACKAGE_INSTALL_COMMAND,
} from "../app/server/agent/python-runtime-packages.ts";
import {
  RUN_PYTHON_INSTRUCTIONS,
  runPythonInstructionsFor,
} from "../app/server/agent/python-tool-instructions.ts";

const expectedPackages = [
  ["numpy", "numpy"],
  ["scipy", "scipy"],
  ["sympy", "sympy"],
  ["pandas", "pandas"],
  ["matplotlib", "matplotlib"],
  ["pillow", "PIL"],
  ["pypdf", "pypdf"],
  ["pymupdf", "fitz"],
  ["pdfplumber", "pdfplumber"],
  ["reportlab", "reportlab"],
  ["python-docx", "docx"],
  ["docx2txt", "docx2txt"],
  ["openpyxl", "openpyxl"],
  ["lxml", "lxml"],
];

test("the trusted runtime catalog preserves exact package and import names", () => {
  assert.deepEqual(
    PYTHON_RUNTIME_PACKAGE_CATALOG.map(({ packageName, importName }) => [packageName, importName]),
    expectedPackages,
  );
});

test("the Modal image install command contains every trusted distribution", () => {
  assert.match(
    PYTHON_RUNTIME_PACKAGE_INSTALL_COMMAND,
    /^RUN python -m pip install --no-cache-dir --disable-pip-version-check /,
  );
  for (const [packageName] of expectedPackages) {
    assert.match(
      PYTHON_RUNTIME_PACKAGE_INSTALL_COMMAND,
      new RegExp(`(?:^| )${packageName.replace("-", "\\-")}(?: |$)`),
    );
  }
});

test("package/import guidance is conditional with the Python tool", () => {
  assert.deepEqual(runPythonInstructionsFor(false), []);
  const [instructions] = runPythonInstructionsFor(true);
  assert.equal(instructions, RUN_PYTHON_INSTRUCTIONS);
  for (const [packageName, importName] of expectedPackages) {
    assert.match(instructions, new RegExp(`${packageName.replace("-", "\\-")} \\(import ${importName}\\)`));
  }
});

test("Modal builds the package layer and migrates venvs without clearing them", async () => {
  const source = await readFile(
    new URL("../app/server/modal/modal-python-executor.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /fromRegistry\("python:3\.13-slim"\)[\s\S]*dockerfileCommands\(\[PYTHON_RUNTIME_PACKAGE_INSTALL_COMMAND\]\)/);
  assert.match(source, /python3 -m venv --system-site-packages \$\{WORKSPACE\}\/\.venv/);
  assert.match(source, /python3 -m venv --system-site-packages --upgrade \$\{WORKSPACE\}\/\.venv/);
  assert.doesNotMatch(source, /python3 -m venv --clear/);
  assert.doesNotMatch(source, /rm\s+-rf\s+\/workspace\/\.venv/);
});
