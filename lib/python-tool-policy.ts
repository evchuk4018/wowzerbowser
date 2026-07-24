import type { PythonToolInput } from "./chat-protocol";

/**
 * Limits shared by the advertised run_python schema and its runtime validator.
 * Keep this module provider- and runtime-neutral so the protocol policy cannot
 * drift between the model-facing schema and the Modal executor.
 */
export const PYTHON_TOOL_INPUT_LIMITS = {
  maxPackages: 20,
  maxArgs: 32,
  maxArtifacts: 20,
} as const;

const MAX_CODE_LENGTH = 64 * 1024;
const PACKAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*(?:[<>=!~]=?[A-Za-z0-9.*+!-]+)?$/;
const PYTHON_TOOL_INPUT_KEYS = new Set([
  "code",
  "file",
  "packages",
  "args",
  "stdin",
  "artifacts",
]);

/** Normalize and validate a path inside the persistent conversation volume. */
export function relativeWorkspacePath(path: string): string {
  const value = path.replace(/\\/g, "/").trim().replace(/^\.\/+/, "");
  const segments = value.split("/");
  if (
    !value ||
    value.startsWith("/") ||
    segments.some((segment) => !segment || segment === "." || segment === "..") ||
    !/^[A-Za-z0-9_./ -]+$/.test(value)
  ) {
    throw new Error("file must be a safe relative path inside the conversation workspace.");
  }
  if (segments[0] === ".venv" || segments[0] === ".runs") {
    throw new Error("file points to a reserved workspace directory.");
  }
  return value;
}

export function validatePythonToolInput(value: unknown): PythonToolInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("run_python arguments must be an object.");
  }
  const input = value as Record<string, unknown>;
  const unexpectedKey = Object.keys(input).find((key) => !PYTHON_TOOL_INPUT_KEYS.has(key));
  if (unexpectedKey) {
    throw new Error(`Unexpected run_python argument: ${unexpectedKey}.`);
  }
  const hasCode = typeof input.code === "string" && input.code.trim().length > 0;
  const hasFile = typeof input.file === "string" && input.file.trim().length > 0;
  if (hasCode === hasFile) throw new Error("Provide exactly one of code or file.");
  if (hasCode && (input.code as string).length > MAX_CODE_LENGTH) {
    throw new Error("code is too long.");
  }

  const packages = input.packages;
  if (
    packages !== undefined &&
    (!Array.isArray(packages) || packages.length > PYTHON_TOOL_INPUT_LIMITS.maxPackages)
  ) {
    throw new Error(`packages must contain at most ${PYTHON_TOOL_INPUT_LIMITS.maxPackages} entries.`);
  }
  const normalizedPackages = packages?.map((pkg, index) => {
    if (typeof pkg !== "string" || pkg.length > 120 || !PACKAGE_PATTERN.test(pkg)) {
      throw new Error(`packages[${index}] is invalid.`);
    }
    return pkg;
  });

  const args = input.args;
  if (
    args !== undefined &&
    (!Array.isArray(args) ||
      args.length > PYTHON_TOOL_INPUT_LIMITS.maxArgs ||
      args.some((arg) => typeof arg !== "string" || arg.length > 4_096))
  ) {
    throw new Error(`args must contain at most ${PYTHON_TOOL_INPUT_LIMITS.maxArgs} bounded strings.`);
  }
  if (input.stdin !== undefined && (typeof input.stdin !== "string" || input.stdin.length > 64 * 1024)) {
    throw new Error("stdin is too long.");
  }
  const requestedArtifacts = input.artifacts;
  if (
    requestedArtifacts !== undefined &&
    (!Array.isArray(requestedArtifacts) ||
      requestedArtifacts.length > PYTHON_TOOL_INPUT_LIMITS.maxArtifacts ||
      requestedArtifacts.some((path) => typeof path !== "string"))
  ) {
    throw new Error(
      `artifacts must contain at most ${PYTHON_TOOL_INPUT_LIMITS.maxArtifacts} string paths.`,
    );
  }

  return {
    ...(hasCode ? { code: input.code as string } : {}),
    ...(hasFile ? { file: relativeWorkspacePath(input.file as string) } : {}),
    ...(normalizedPackages?.length ? { packages: normalizedPackages } : {}),
    ...(args ? { args: args as string[] } : {}),
    ...(typeof input.stdin === "string" ? { stdin: input.stdin } : {}),
    ...(requestedArtifacts
      ? { artifacts: requestedArtifacts.map((path) => relativeWorkspacePath(path as string)) }
      : {}),
  };
}
