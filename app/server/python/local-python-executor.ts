import "server-only";

import { PYTHON_TOOL_INPUT_LIMITS, relativeWorkspacePath, validatePythonToolInput } from "../../../lib/python-tool-policy";
import { runtimeConfigSnapshot } from "../config/runtime-config-service";

export { relativeWorkspacePath, validatePythonToolInput } from "../../../lib/python-tool-policy";

export const PYTHON_TOOL_LIMITS = {
  cpu: 0.75,
  memoryMb: 1536,
  callTimeoutMs: 60_000,
  responseTimeoutMs: 240_000,
  maxCodeLength: 64 * 1024,
  maxOutputLength: 64 * 1024,
  maxArtifacts: PYTHON_TOOL_INPUT_LIMITS.maxArtifacts,
  maxArtifactBytes: 25 * 1024 * 1024,
  maxArtifactTotalBytes: 50 * 1024 * 1024,
  maxStreamingWorkspaceBytes: 1 * 1024 * 1024 * 1024,
} as const;

export const PYTHON_WORKER_URL = "http://python-worker:5003";
const PYTHON_WORKER_SECRET = process.env.PYTHON_WORKER_SECRET?.trim() || "";
const PYTHON_WORKER_TIMEOUT_MESSAGE = "The local Python worker did not complete before its deadline.";

export type LocalExecArtifact = {
  path: string;
  size: number;
  sha256: string;
};

export type LocalExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut?: boolean;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  artifacts?: LocalExecArtifact[];
};

export type IsolatedPythonResult = Omit<LocalExecResult, "artifacts">;

export type WorkspaceSearchMatch = {
  path: string;
  line: number;
  column: number;
  excerpt: string;
};

export type WorkspaceSearchResult = {
  matches: WorkspaceSearchMatch[];
  truncated: boolean;
};

export type WorkspaceWriteOptions = {
  overwrite?: boolean;
  replace?: boolean;
  expectedSha256?: string;
};

export type WorkspaceByteSource = ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;

export type LocalCommandInput = {
  command: string;
  args?: string[];
  cwd?: string;
  stdin?: string;
  timeoutMs?: number;
};

export type LocalCommandChangedFile = {
  path: string;
  name: string;
  size: number;
  contentType: string;
  language: string;
  editable: boolean;
  preview: "html" | "markdown" | "svg" | "image" | "text" | "none";
  sha256?: string;
};

/** Command metadata is kept structural so this runtime slice has no protocol-layer dependency. */
export type LocalCommandResult = {
  command: string;
  args: string[];
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut?: boolean;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  changedFiles?: LocalCommandChangedFile[];
};

export function isLocalPythonConfigured(): boolean {
  return Boolean(currentPythonWorkerUrl() && PYTHON_WORKER_SECRET.length >= 32);
}

export function currentPythonWorkerUrl(): string {
  return runtimeConfigSnapshot().pythonWorkerUrl || PYTHON_WORKER_URL;
}

function workerUrl(path: string): string {
  return new URL(path, `${currentPythonWorkerUrl().replace(/\/+$/u, "")}/`).toString();
}

function assertConfigured(): void {
  if (!isLocalPythonConfigured()) throw new Error("The local Python worker is not configured.");
}

async function responseError(response: Response): Promise<Error> {
  const body = await response.text().catch(() => "");
  let message = "The local Python worker rejected the request.";
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed.error === "string" && parsed.error.length <= 1_000) message = parsed.error;
  } catch {
    // Keep the worker's internal response out of the application error.
  }
  return new Error(`${message} (status ${response.status})`);
}

async function fetchWithDeadline(
  path: string,
  init: RequestInit & { duplex?: "half" },
  deadlineAt: number,
): Promise<Response> {
  assertConfigured();
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) throw new Error(PYTHON_WORKER_TIMEOUT_MESSAGE);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), remainingMs);
  try {
    return await fetch(workerUrl(path), {
      ...init,
      signal: controller.signal,
      headers: {
        ...(init.headers ?? {}),
        "x-python-worker-secret": PYTHON_WORKER_SECRET,
      },
    });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(PYTHON_WORKER_TIMEOUT_MESSAGE);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function boundedWorkspaceByteStream(source: WorkspaceByteSource, size: number): ReadableStream<Uint8Array> {
  const candidate = source as ReadableStream<Uint8Array> & AsyncIterable<Uint8Array>;
  const reader = typeof candidate?.getReader === "function" ? candidate.getReader() : null;
  const iterator = reader === null && typeof candidate?.[Symbol.asyncIterator] === "function"
    ? candidate[Symbol.asyncIterator]()
    : null;
  if (reader === null && iterator === null) throw new Error("Workspace stream source must be a ReadableStream or async byte source.");

  let total = 0;
  let released = false;
  const releaseReader = () => {
    if (!released && reader !== null) {
      released = true;
      reader.releaseLock();
    }
  };
  const nextChunk = async (): Promise<IteratorResult<Uint8Array>> => reader !== null ? reader.read() : await iterator!.next();
  const cancelSource = async (reason: unknown) => {
    if (reader !== null) {
      await reader.cancel(reason).catch(() => undefined);
      releaseReader();
    } else if (iterator?.return) {
      await iterator.return(reason).catch(() => undefined);
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await nextChunk();
        if (result.done) {
          releaseReader();
          if (total !== size) throw new Error("Workspace stream source ended before the declared size.");
          controller.close();
          return;
        }
        if (!(result.value instanceof Uint8Array)) throw new Error("Workspace stream source must yield Uint8Array chunks.");
        if (result.value.byteLength > size - total) throw new Error("Workspace stream source exceeded the declared size.");
        total += result.value.byteLength;
        controller.enqueue(result.value);
        if (total === size) {
          releaseReader();
          controller.close();
        }
      } catch (error) {
        releaseReader();
        controller.error(error);
      }
    },
    async cancel(reason) {
      await cancelSource(reason);
    },
  });
}

async function requestJson<T>(path: string, value: unknown, deadlineAt: number, method = "POST"): Promise<T> {
  const response = await fetchWithDeadline(path, {
    method,
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(value),
  }, deadlineAt);
  if (!response.ok) throw await responseError(response);
  return await response.json() as T;
}

function workspaceDirectoryPath(pathValue: string | undefined): string {
  if (pathValue === undefined || pathValue.trim() === "" || pathValue.trim() === "." || pathValue.trim() === "./") return "";
  return relativeWorkspacePath(pathValue);
}

const BLOCKED_COMMANDS = new Set(["bash", "busybox", "csh", "dash", "fish", "ksh", "sh", "zsh"]);

function writeOptions(value: boolean | WorkspaceWriteOptions): Required<Pick<WorkspaceWriteOptions, "overwrite">> & Pick<WorkspaceWriteOptions, "expectedSha256"> {
  if (typeof value === "boolean") return { overwrite: value };
  if (!value || typeof value !== "object") throw new Error("Workspace write options are invalid.");
  const overwrite = value.overwrite ?? value.replace ?? false;
  if (typeof overwrite !== "boolean") throw new Error("Workspace write overwrite must be a boolean.");
  if (value.expectedSha256 !== undefined && !/^[0-9a-f]{64}$/iu.test(value.expectedSha256)) throw new Error("expectedSha256 must be a SHA-256 hex digest.");
  return { overwrite, ...(value.expectedSha256 ? { expectedSha256: value.expectedSha256 } : {}) };
}

export async function runIsolatedPythonTool(
  source: string,
  input: unknown,
  environment: Record<string, string>,
  deadlineAt = Date.now() + PYTHON_TOOL_LIMITS.callTimeoutMs,
): Promise<IsolatedPythonResult> {
  const result = await requestJson<IsolatedPythonResult>("/v1/isolated", {
    source,
    input,
    environment,
    deadlineAt,
  }, deadlineAt);
  return result;
}

export class LocalPythonExecutor {
  private session: string | null = null;
  private sessionPromise: Promise<string> | null = null;

  constructor(
    private readonly ownerId: string,
    private readonly conversationId: string,
    private readonly responseDeadlineAt = Date.now() + PYTHON_TOOL_LIMITS.responseTimeoutMs,
    private workspaceId = conversationId,
  ) {}

  withWorkspaceId(workspaceId: string): this {
    this.workspaceId = workspaceId;
    return this;
  }

  private async ensureSession(deadlineAt: number): Promise<string> {
    if (this.session) return this.session;
    if (!this.sessionPromise) {
      this.sessionPromise = requestJson<{ session: string }>("/v1/sessions/open", {
        ownerId: this.ownerId,
        conversationId: this.conversationId,
        workspaceId: this.workspaceId,
      }, deadlineAt).then((result) => {
        if (!result.session) throw new Error("The local Python worker did not return a session.");
        this.session = result.session;
        return result.session;
      }).finally(() => {
        this.sessionPromise = null;
      });
    }
    return this.sessionPromise;
  }

  async run(inputValue: unknown): Promise<LocalExecResult> {
    const startedAt = Date.now();
    if (startedAt >= this.responseDeadlineAt) throw new Error("The response reached its configured execution limit.");
    const input = validatePythonToolInput(inputValue);
    const callDeadlineAt = Math.min(this.responseDeadlineAt, startedAt + PYTHON_TOOL_LIMITS.callTimeoutMs);
    const session = await this.ensureSession(callDeadlineAt);
    return requestJson<LocalExecResult>("/v1/execute", {
      session,
      input,
      deadlineAt: callDeadlineAt,
    }, callDeadlineAt);
  }

  async readArtifact(pathValue: string): Promise<Uint8Array> {
    const session = await this.ensureSession(this.responseDeadlineAt);
    const path = relativeWorkspacePath(pathValue);
    const response = await fetchWithDeadline("/v1/workspace/read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session, path }),
    }, this.responseDeadlineAt);
    if (!response.ok) throw await responseError(response);
    return new Uint8Array(await response.arrayBuffer());
  }

  async readWorkspaceFile(pathValue: string): Promise<Uint8Array> {
    return this.readArtifact(pathValue);
  }

  async createWorkspaceDirectory(pathValue: string): Promise<void> {
    const path = relativeWorkspacePath(pathValue);
    if (!path.startsWith("documents/")) throw new Error("Only canonical document directories may be created.");
    const session = await this.ensureSession(this.responseDeadlineAt);
    await requestJson("/v1/workspace/mkdir", { session, path }, this.responseDeadlineAt);
  }

  async writeWorkspaceFile(pathValue: string, bytes: Uint8Array, overwriteOrOptions: boolean | WorkspaceWriteOptions = false): Promise<void> {
    const path = relativeWorkspacePath(pathValue);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > PYTHON_TOOL_LIMITS.maxArtifactBytes) throw new Error("Workspace write is not allowed.");
    const options = writeOptions(overwriteOrOptions);
    const session = await this.ensureSession(this.responseDeadlineAt);
    const encoded = Buffer.from(bytes).toString("base64");
    await requestJson("/v1/workspace/write", {
      session,
      path,
      bytes: encoded,
      ...(options.overwrite ? { replace: true } : {}),
      ...(options.expectedSha256 ? { expectedSha256: options.expectedSha256 } : {}),
    }, this.responseDeadlineAt, "PUT");
  }

  async writeWorkspaceStream(
    pathValue: string,
    source: WorkspaceByteSource,
    size: number,
    overwriteOrOptions: boolean | WorkspaceWriteOptions = false,
  ): Promise<{ size: number; sha256: string }> {
    const path = relativeWorkspacePath(pathValue);
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 || size > PYTHON_TOOL_LIMITS.maxStreamingWorkspaceBytes) {
      throw new Error("Streaming workspace write size must be an integer between 0 and 1073741824 bytes.");
    }
    const options = writeOptions(overwriteOrOptions);
    const session = await this.ensureSession(this.responseDeadlineAt);
    const body = boundedWorkspaceByteStream(source, size);
    const response = await fetchWithDeadline("/v1/workspace/write-stream", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/octet-stream",
        "content-length": String(size),
        "x-python-session": session,
        "x-workspace-path": path,
        "x-workspace-size": String(size),
        "x-workspace-replace": String(options.overwrite),
        ...(options.expectedSha256 ? { "x-workspace-expected-sha256": options.expectedSha256 } : {}),
      },
      body,
      duplex: "half",
    }, this.responseDeadlineAt);
    if (!response.ok) throw await responseError(response);
    const result = await response.json() as { size?: unknown; sha256?: unknown };
    if (result.size !== size || typeof result.sha256 !== "string" || !/^[0-9a-f]{64}$/iu.test(result.sha256)) throw new Error("The local Python worker returned invalid workspace stream metadata.");
    return { size, sha256: result.sha256.toLowerCase() };
  }

  async replaceWorkspaceFile(pathValue: string, bytes: Uint8Array): Promise<void>;
  async replaceWorkspaceFile(pathValue: string, expectedSha256: string | undefined | null, bytes: Uint8Array): Promise<void>;
  async replaceWorkspaceFile(pathValue: string, expectedSha256OrBytes: string | Uint8Array | null | undefined, bytesValue?: Uint8Array): Promise<void> {
    const expectedSha256 = typeof expectedSha256OrBytes === "string" ? expectedSha256OrBytes : undefined;
    const bytes = expectedSha256OrBytes instanceof Uint8Array ? expectedSha256OrBytes : bytesValue;
    if (!bytes) throw new Error("Replacement bytes are required.");
    await this.writeWorkspaceFile(pathValue, bytes, { overwrite: true, ...(expectedSha256 ? { expectedSha256 } : {}) });
  }

  async copyWorkspaceFile(sourceValue: string, destinationValue: string): Promise<void> {
    const bytes = await this.readWorkspaceFile(sourceValue);
    await this.writeWorkspaceFile(destinationValue, bytes);
  }

  async listWorkspaceTree(rootValue = ""): Promise<Array<{ path: string; size: number }>> {
    const root = workspaceDirectoryPath(rootValue);
    const session = await this.ensureSession(this.responseDeadlineAt);
    const result = await requestJson<{ items: Array<{ path: string; size: number }> }>("/v1/workspace/list", { session, path: root }, this.responseDeadlineAt);
    return result.items;
  }

  async searchWorkspace(query: string, rootValue = ""): Promise<WorkspaceSearchResult> {
    if (typeof query !== "string" || !query || query.length > 1_024) throw new Error("Search query must be a bounded non-empty string.");
    const root = workspaceDirectoryPath(rootValue);
    const session = await this.ensureSession(this.responseDeadlineAt);
    return requestJson<WorkspaceSearchResult>("/v1/workspace/search", { session, query, root }, this.responseDeadlineAt);
  }

  async deleteWorkspaceFile(pathValue: string): Promise<void> {
    const path = relativeWorkspacePath(pathValue);
    const session = await this.ensureSession(this.responseDeadlineAt);
    await requestJson("/v1/workspace/delete", { session, path }, this.responseDeadlineAt);
  }

  async runCommand(input: LocalCommandInput): Promise<LocalCommandResult> {
    if (!input || typeof input !== "object" || typeof input.command !== "string" || !input.command || input.command.length > 128 || /[^A-Za-z0-9._+-]/u.test(input.command) || BLOCKED_COMMANDS.has(input.command.toLowerCase())) {
      throw new Error("command must name a permitted executable without shell syntax.");
    }
    const args = input.args ?? [];
    if (!Array.isArray(args) || args.length > 32 || args.some((arg) => typeof arg !== "string" || arg.length > 4_096)) throw new Error("args must contain at most 32 bounded strings.");
    if (args.reduce((total, arg) => total + Buffer.byteLength(arg, "utf8"), 0) > 64 * 1024) throw new Error("command arguments are too large.");
    if (input.stdin !== undefined && (typeof input.stdin !== "string" || Buffer.byteLength(input.stdin, "utf8") > 64 * 1024)) throw new Error("stdin is too long.");
    const timeoutMs = input.timeoutMs ?? PYTHON_TOOL_LIMITS.callTimeoutMs;
    if (!Number.isFinite(timeoutMs) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > PYTHON_TOOL_LIMITS.callTimeoutMs) throw new Error("timeoutMs must be between 1 and 60000.");
    const cwd = workspaceDirectoryPath(input.cwd);
    const startedAt = Date.now();
    const deadlineAt = Math.min(this.responseDeadlineAt, startedAt + timeoutMs);
    if (startedAt >= this.responseDeadlineAt) throw new Error("The response reached its configured execution limit.");
    const session = await this.ensureSession(deadlineAt);
    return requestJson<LocalCommandResult>("/v1/command", {
      session,
      command: input.command,
      args,
      cwd,
      ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
      timeoutMs,
      deadlineAt,
    }, deadlineAt);
  }

  async close(): Promise<void> {
    const session = this.session;
    this.session = null;
    this.sessionPromise = null;
    if (!session || !isLocalPythonConfigured()) return;
    await requestJson("/v1/sessions/close", { session }, Date.now() + 5_000).catch(() => undefined);
  }
}
