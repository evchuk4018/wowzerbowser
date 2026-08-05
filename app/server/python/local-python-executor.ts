import "server-only";

import { PYTHON_TOOL_INPUT_LIMITS, relativeWorkspacePath, validatePythonToolInput } from "../../../lib/python-tool-policy";

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
} as const;

export const PYTHON_WORKER_URL = process.env.PYTHON_WORKER_URL?.trim() || "http://python-worker:5003";
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

export function isLocalPythonConfigured(): boolean {
  return Boolean(PYTHON_WORKER_URL && PYTHON_WORKER_SECRET.length >= 32);
}

function workerUrl(path: string): string {
  return new URL(path, `${PYTHON_WORKER_URL.replace(/\/+$/u, "")}/`).toString();
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
  init: RequestInit,
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

async function requestJson<T>(path: string, value: unknown, deadlineAt: number, method = "POST"): Promise<T> {
  const response = await fetchWithDeadline(path, {
    method,
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(value),
  }, deadlineAt);
  if (!response.ok) throw await responseError(response);
  return await response.json() as T;
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
  ) {}

  private async ensureSession(deadlineAt: number): Promise<string> {
    if (this.session) return this.session;
    if (!this.sessionPromise) {
      this.sessionPromise = requestJson<{ session: string }>("/v1/sessions/open", {
        ownerId: this.ownerId,
        conversationId: this.conversationId,
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
    if (startedAt >= this.responseDeadlineAt) throw new Error("The response reached its 240-second execution limit.");
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

  async writeWorkspaceFile(pathValue: string, bytes: Uint8Array): Promise<void> {
    const path = relativeWorkspacePath(pathValue);
    if (!path.startsWith("documents/") || bytes.byteLength > PYTHON_TOOL_LIMITS.maxArtifactBytes) throw new Error("Document workspace write is not allowed.");
    const session = await this.ensureSession(this.responseDeadlineAt);
    const encoded = Buffer.from(bytes).toString("base64");
    await requestJson("/v1/workspace/write", { session, path, bytes: encoded }, this.responseDeadlineAt, "PUT");
  }

  async copyWorkspaceFile(sourceValue: string, destinationValue: string): Promise<void> {
    const bytes = await this.readWorkspaceFile(sourceValue);
    await this.writeWorkspaceFile(destinationValue, bytes);
  }

  async listWorkspaceTree(rootValue: string): Promise<Array<{ path: string; size: number }>> {
    const root = relativeWorkspacePath(rootValue);
    const session = await this.ensureSession(this.responseDeadlineAt);
    const result = await requestJson<{ items: Array<{ path: string; size: number }> }>("/v1/workspace/list", { session, path: root }, this.responseDeadlineAt);
    return result.items;
  }

  async close(): Promise<void> {
    const session = this.session;
    this.session = null;
    this.sessionPromise = null;
    if (!session || !isLocalPythonConfigured()) return;
    await requestJson("/v1/sessions/close", { session }, Date.now() + 5_000).catch(() => undefined);
  }
}
