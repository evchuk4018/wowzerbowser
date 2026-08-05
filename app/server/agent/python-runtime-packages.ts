/**
 * Packages baked into the local Python worker image and exposed through the
 * conversation venv's system site packages.
 *
 * Keep distribution names (the names accepted by pip) separate from import
 * names. Several useful packages intentionally have different names, such as
 * Pillow/PIL, PyMuPDF/pymupdf, and python-docx/docx.
 */
export const PYTHON_RUNTIME_PACKAGES = Object.freeze([
  { packageName: "numpy", importName: "numpy" },
  { packageName: "scipy", importName: "scipy" },
  { packageName: "sympy", importName: "sympy" },
  { packageName: "pandas", importName: "pandas" },
  { packageName: "matplotlib", importName: "matplotlib" },
  { packageName: "pillow", importName: "PIL" },
  { packageName: "pypdf", importName: "pypdf" },
  { packageName: "pymupdf", importName: "fitz" },
  { packageName: "pdfplumber", importName: "pdfplumber" },
  { packageName: "reportlab", importName: "reportlab" },
  { packageName: "python-docx", importName: "docx" },
  { packageName: "docx2txt", importName: "docx2txt" },
  { packageName: "openpyxl", importName: "openpyxl" },
  { packageName: "lxml", importName: "lxml" },
] as const);

/** Alias that makes the catalog role explicit at call sites and in tests. */
export const PYTHON_RUNTIME_PACKAGE_CATALOG = PYTHON_RUNTIME_PACKAGES;

export const PYTHON_RUNTIME_PACKAGE_NAMES = Object.freeze(
  PYTHON_RUNTIME_PACKAGES.map(({ packageName }) => packageName),
);

/** A Dockerfile RUN instruction used by local worker image maintainers. */
export const PYTHON_RUNTIME_PACKAGE_INSTALL_COMMAND = [
  "RUN python -m pip install --no-cache-dir --disable-pip-version-check",
  ...PYTHON_RUNTIME_PACKAGE_NAMES,
].join(" ");

/** Human-readable distribution-to-import mapping for the model's system prompt. */
export const PYTHON_RUNTIME_PACKAGE_INSTRUCTIONS = PYTHON_RUNTIME_PACKAGES.map(
  ({ packageName, importName }) => `${packageName} (import ${importName})`,
).join(", ");
