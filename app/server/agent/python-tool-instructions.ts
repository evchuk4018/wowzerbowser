import { PYTHON_RUNTIME_PACKAGE_INSTRUCTIONS } from "./python-runtime-packages";

/**
 * Provider-neutral guidance for the model when the run_python tool is
 * available. This is deliberately kept outside the UI prompt: execution
 * capability is a server decision and must not be implied when Modal is off.
 */
export const RUN_PYTHON_INSTRUCTIONS = [
  "<run_python_policy>",
  "Use run_python for useful computation, data transformation, file generation, or checking a result that benefits from execution; answer directly when Python would not add value.",
  "Call run_python with a JSON object. Each call must provide exactly one of code (non-empty inline Python) or file (an existing relative Python file path), never both. For example: {\"code\":\"print(sum([2, 3, 5]))\"}.",
  "The code/file runs in a persistent conversation workspace. File paths must stay relative to that workspace; do not use absolute paths, parent traversal, .venv, or .runs.",
  `The runtime image preinstalls these trusted packages. Use the exact pip package/import pairs shown here: ${PYTHON_RUNTIME_PACKAGE_INSTRUCTIONS}.`,
  "packages is optional and may contain at most 20 package specifiers; args is optional and may contain at most 32 strings; stdin is optional.",
  "Request files with artifacts when the user needs a downloadable output. Write each requested file to a relative workspace path and include that exact same path in artifacts; paths are relative and at most 20 may be requested.",
  "When the user asks you to create a PDF, make an actual run_python call instead of only showing Python source. Use the preinstalled ReportLab package directly; do not install it or make a separate probe call first. Generate the PDF in one call at a safe relative path such as short_story.pdf and include the identical path in that call's artifacts array, for example artifacts: [\"short_story.pdf\"].",
  "Do not claim that a requested file was created until the run_python result has ok: true and includes the expected file in artifacts. If execution fails or the artifact is missing, inspect stderr and correct the generation call.",
  "Generated PDF/DOCX files are persisted as source-backed document projects. Prefer a named reusable source file, keep required local source/assets under one bounded project directory, and ensure the source can rerender the document.",
  "After each call, inspect the result fields ok, stdout, stderr, exitCode, timedOut, stdoutTruncated, stderrTruncated, and artifacts before deciding what to do next.",
  "</run_python_policy>",
].join("\n");

export function runPythonInstructionsFor(advertised: boolean): string[] {
  return advertised ? [RUN_PYTHON_INSTRUCTIONS] : [];
}
