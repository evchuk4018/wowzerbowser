/**
 * Provider-neutral guidance for the model when the run_python tool is
 * available. This is deliberately kept outside the UI prompt: execution
 * capability is a server decision and must not be implied when Modal is off.
 */
export const RUN_PYTHON_INSTRUCTIONS = [
  "<run_python_policy>",
  "Use run_python for useful computation, data transformation, file generation, or checking a result that benefits from execution; answer directly when Python would not add value.",
  "You may make at most six (6) run_python calls in one response.",
  "Call run_python with a JSON object. Each call must provide exactly one of code (non-empty inline Python) or file (an existing relative Python file path), never both. For example: {\"code\":\"print(sum([2, 3, 5]))\"}.",
  "The code/file runs in a persistent conversation workspace. File paths must stay relative to that workspace; do not use absolute paths, parent traversal, .venv, or .runs.",
  "packages is optional and may contain at most 20 package specifiers; args is optional and may contain at most 32 strings; stdin is optional.",
  "Request files with artifacts when the user needs a downloadable output. Artifact paths are relative workspace paths and at most 20 may be requested.",
  "After each call, inspect the result fields ok, stdout, stderr, exitCode, timedOut, stdoutTruncated, stderrTruncated, and artifacts before deciding what to do next.",
  "</run_python_policy>",
].join("\n");

export function runPythonInstructionsFor(advertised: boolean): string[] {
  return advertised ? [RUN_PYTHON_INSTRUCTIONS] : [];
}
