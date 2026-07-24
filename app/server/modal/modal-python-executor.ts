import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { AlreadyExistsError, ModalClient, type ModalReadStream, type Sandbox } from "modal";
import {
  boundedPythonTimeoutMs,
  waitForPythonDeadline,
} from "../../../lib/python-execution-deadlines";
import { PYTHON_TOOL_INPUT_LIMITS, relativeWorkspacePath, validatePythonToolInput } from "../../../lib/python-tool-policy";

export { relativeWorkspacePath, validatePythonToolInput } from "../../../lib/python-tool-policy";

export const PYTHON_TOOL_LIMITS = {
  cpu: 1,
  memoryMb: 1024,
  callTimeoutMs: 60_000,
  maxCalls: 6,
  responseTimeoutMs: 240_000,
  maxCodeLength: 64 * 1024,
  maxOutputLength: 64 * 1024,
  maxArtifacts: PYTHON_TOOL_INPUT_LIMITS.maxArtifacts,
  maxArtifactBytes: 25 * 1024 * 1024,
  maxArtifactTotalBytes: 50 * 1024 * 1024,
} as const;

const APP_NAME = process.env.MODAL_APP_NAME?.trim() || "wowzerbowser-python";
const WORKSPACE = "/workspace";
const VENV_PYTHON = `${WORKSPACE}/.venv/bin/python`;

type FileSnapshot = {
  path: string;
  size: number;
  mtimeNs: number;
};

export type ModalExecArtifact = {
  path: string;
  size: number;
  sha256: string;
};

export type ModalExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut?: boolean;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  artifacts?: ModalExecArtifact[];
};

export function isModalConfigured(): boolean {
  return Boolean(
    process.env.MODAL_TOKEN_ID?.trim() &&
      process.env.MODAL_TOKEN_SECRET?.trim() &&
      process.env.ARTIFACT_SIGNING_SECRET?.trim(),
  );
}

function resourceDigest(ownerId: string, conversationId: string): string {
  return createHash("sha256")
    .update(`${ownerId}:${conversationId}`)
    .digest("hex")
    .slice(0, 32);
}

export function conversationVolumeName(ownerId: string, conversationId: string): string {
  return `chat-volume-${resourceDigest(ownerId, conversationId)}`;
}

export function responseSandboxName(ownerId: string, conversationId: string): string {
  return `chat-response-${resourceDigest(ownerId, conversationId)}`;
}

const PYTHON_DEADLINE_ERROR =
  "Python execution timed out before its 60-second call or 240-second response deadline.";
const BOUNDED_ARTIFACT_READ_SCRIPT = [
  "import os, stat, sys",
  "root, relative, limit_text = sys.argv[1:4]",
  "limit = int(limit_text)",
  "parts = relative.split('/')",
  "if not hasattr(os, 'O_NOFOLLOW'):",
  "    raise OSError('no-follow file reads are unavailable')",
  "flags_base = os.O_RDONLY | getattr(os, 'O_CLOEXEC', 0) | os.O_NOFOLLOW",
  "fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)",
  "try:",
  "    for index, part in enumerate(parts):",
  "        flags = flags_base",
  "        if index < len(parts) - 1:",
  "            flags |= os.O_DIRECTORY",
  "        next_fd = os.open(part, flags, dir_fd=fd)",
  "        os.close(fd)",
  "        fd = next_fd",
  "    if not stat.S_ISREG(os.fstat(fd).st_mode):",
  "        raise OSError('artifact must be a regular file')",
  "    remaining = limit",
  "    while remaining > 0:",
  "        chunk = os.read(fd, min(65536, remaining))",
  "        if not chunk:",
  "            break",
  "        sys.stdout.buffer.write(chunk)",
  "        remaining -= len(chunk)",
  "finally:",
  "    os.close(fd)",
].join("\n");

function assertDeadline(deadlineAt: number): void {
  if (Date.now() >= deadlineAt) throw new Error(PYTHON_DEADLINE_ERROR);
}

async function runProcess(
  sandbox: Sandbox,
  command: string[],
  options: { stdin?: string; timeoutMs?: number; outputLimit?: number; deadlineAt?: number } = {},
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}> {
  const deadlineAt = options.deadlineAt ?? Date.now() + PYTHON_TOOL_LIMITS.callTimeoutMs;
  const timeoutMs = boundedPythonTimeoutMs(
    options.timeoutMs ?? PYTHON_TOOL_LIMITS.callTimeoutMs,
    deadlineAt,
    Date.now(),
    PYTHON_TOOL_LIMITS.callTimeoutMs,
  );
  if (timeoutMs <= 0) throw new Error(PYTHON_DEADLINE_ERROR);
  const process = await sandbox.exec(command, {
    workdir: WORKSPACE,
    timeoutMs,
  });
  if (options.stdin !== undefined) {
    await process.stdin.writeText(options.stdin);
  }
  await process.closeStdin();
  const outputLimit = options.outputLimit ?? PYTHON_TOOL_LIMITS.maxOutputLength;
  const [stdout, stderr, exitCode] = await Promise.all([
    drainBounded(process.stdout, outputLimit),
    drainBounded(process.stderr, outputLimit),
    process.wait(),
  ]);
  return {
    stdout: stdout.value,
    stderr: stderr.value,
    exitCode,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
  };
}

async function drainBounded(
  stream: ModalReadStream<string>,
  limit: number,
): Promise<{ value: string; truncated: boolean }> {
  const reader = stream.getReader();
  const chunks: string[] = [];
  let length = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length < limit) {
        const remaining = limit - length;
        chunks.push(value.slice(0, remaining));
        length += Math.min(value.length, remaining);
        if (value.length > remaining) truncated = true;
      } else if (value.length > 0) {
        truncated = true;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return {
    value: `${chunks.join("")}${truncated ? "\n[output truncated]" : ""}`,
    truncated,
  };
}

async function drainBoundedBytes(
  stream: ModalReadStream<Uint8Array>,
  limit: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length >= limit) continue;
      const chunk = value.subarray(0, limit - length);
      chunks.push(chunk);
      length += chunk.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function readBoundedArtifactBytes(
  sandbox: Sandbox,
  path: string,
  deadlineAt: number,
): Promise<Uint8Array> {
  const timeoutMs = boundedPythonTimeoutMs(
    PYTHON_TOOL_LIMITS.callTimeoutMs,
    deadlineAt,
    Date.now(),
    PYTHON_TOOL_LIMITS.callTimeoutMs,
  );
  if (timeoutMs <= 0) throw new Error(PYTHON_DEADLINE_ERROR);

  const readLimit = PYTHON_TOOL_LIMITS.maxArtifactBytes + 1;
  const process = await sandbox.exec(
    [
      "python3",
      "-c",
      BOUNDED_ARTIFACT_READ_SCRIPT,
      WORKSPACE,
      path,
      String(readLimit),
    ],
    {
      mode: "binary",
      workdir: WORKSPACE,
      timeoutMs,
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    drainBoundedBytes(process.stdout, readLimit),
    drainBoundedBytes(process.stderr, PYTHON_TOOL_LIMITS.maxOutputLength),
    process.wait(),
  ]);
  if (exitCode !== 0) {
    const message = new TextDecoder().decode(stderr).trim();
    throw new Error(message || "Unable to read artifact safely.");
  }
  if (stdout.byteLength > PYTHON_TOOL_LIMITS.maxArtifactBytes) {
    throw new Error("Artifact exceeds the 25 MiB download limit.");
  }
  return stdout;
}

async function snapshotFiles(sandbox: Sandbox, deadlineAt: number): Promise<Map<string, FileSnapshot>> {
  const script = [
    "import json, os",
    `root=${JSON.stringify(WORKSPACE)}`,
    "items=[]",
    "for base, dirs, files in os.walk(root):",
    "    dirs[:] = [d for d in dirs if d not in {'.venv', '.runs', '__pycache__'}]",
    "    for name in files:",
    "        p=os.path.join(base,name)",
    "        try:",
    "            s=os.stat(p)",
    "        except OSError:",
    "            continue",
    "        items.append({'path':os.path.relpath(p,root).replace(os.sep,'/'),'size':s.st_size,'mtimeNs':s.st_mtime_ns})",
    "print(json.dumps(items))",
  ].join("\n");
  const result = await runProcess(sandbox, ["python3", "-c", script], {
    timeoutMs: 10_000,
    outputLimit: 512 * 1024,
    deadlineAt,
  });
  if (result.exitCode !== 0) return new Map();
  const items = JSON.parse(result.stdout) as FileSnapshot[];
  return new Map(items.map((item) => [item.path, item]));
}

async function createWorkspaceSandbox(
  ownerId: string,
  conversationId: string,
  options: {
    readOnly?: boolean;
    name?: string;
    blockNetwork?: boolean;
    deadlineAt?: number;
  } = {},
): Promise<{ client: ModalClient; sandbox: Sandbox }> {
  if (!isModalConfigured()) throw new Error("Modal Python execution is not configured.");
  const deadlineAt =
    options.deadlineAt ??
    Date.now() +
      (options.readOnly ? PYTHON_TOOL_LIMITS.callTimeoutMs : PYTHON_TOOL_LIMITS.responseTimeoutMs);
  assertDeadline(deadlineAt);
  const client = new ModalClient();
  let sandboxCreation: Promise<Sandbox> | null = null;
  try {
    const [app, volume] = await waitForPythonDeadline(
      Promise.all([
        client.apps.fromName(APP_NAME, { createIfMissing: true }),
        client.volumes.fromName(conversationVolumeName(ownerId, conversationId), {
          createIfMissing: true,
        }),
      ]),
      deadlineAt,
      PYTHON_DEADLINE_ERROR,
    );
    const image = client.images.fromRegistry("python:3.13-slim");
    sandboxCreation = client.sandboxes.create(app, image, {
      name: options.name,
      cpu: PYTHON_TOOL_LIMITS.cpu,
      cpuLimit: PYTHON_TOOL_LIMITS.cpu,
      memoryMiB: PYTHON_TOOL_LIMITS.memoryMb,
      memoryLimitMiB: PYTHON_TOOL_LIMITS.memoryMb,
      timeoutMs: options.readOnly ? 60_000 : PYTHON_TOOL_LIMITS.responseTimeoutMs,
      idleTimeoutMs: options.readOnly ? 30_000 : 120_000,
      workdir: WORKSPACE,
      volumes: {
        [WORKSPACE]: options.readOnly ? volume.withMountOptions({ readOnly: true }) : volume,
      },
      ...(options.blockNetwork
        ? { blockNetwork: true }
        : {
            outboundDomainAllowlist: ["*"],
            outboundCidrAllowlist: [],
          }),
    });
    const sandbox = await waitForPythonDeadline(
      sandboxCreation,
      deadlineAt,
      PYTHON_DEADLINE_ERROR,
    );
    return { client, sandbox };
  } catch (error) {
    if (sandboxCreation) {
      void sandboxCreation
        .then(async (sandbox) => {
          try {
            await sandbox.terminate();
          } finally {
            client.close();
          }
        })
        .catch(() => client.close());
    } else {
      client.close();
    }
    throw error;
  }
}

export async function readConversationArtifact(
  ownerId: string,
  conversationId: string,
  pathValue: string,
): Promise<Uint8Array> {
  const path = relativeWorkspacePath(pathValue);
  const deadlineAt = Date.now() + PYTHON_TOOL_LIMITS.callTimeoutMs;
  const { client, sandbox } = await createWorkspaceSandbox(ownerId, conversationId, {
    readOnly: true,
    blockNetwork: true,
    name: `chat-artifact-${randomUUID().replaceAll("-", "").slice(0, 24)}`,
    deadlineAt,
  });
  try {
    return await waitForPythonDeadline(
      readBoundedArtifactBytes(sandbox, path, deadlineAt),
      deadlineAt,
      PYTHON_DEADLINE_ERROR,
    );
  } finally {
    await sandbox.terminate().catch(() => undefined);
    client.close();
  }
}

export class ModalPythonExecutor {
  private sandbox: Sandbox | null = null;
  private client: ModalClient | null = null;
  private calls = 0;

  constructor(
    private readonly ownerId: string,
    private readonly conversationId: string,
    private readonly responseDeadlineAt = Date.now() + PYTHON_TOOL_LIMITS.responseTimeoutMs,
  ) {}

  private async ensureSandbox(deadlineAt: number): Promise<Sandbox> {
    if (this.sandbox) return this.sandbox;
    let created;
    try {
      // The deterministic name is a cross-instance lease: a second tab cannot
      // concurrently mutate the same persistent conversation volume.
      created = await createWorkspaceSandbox(this.ownerId, this.conversationId, {
        name: responseSandboxName(this.ownerId, this.conversationId),
        deadlineAt,
      });
    } catch (error) {
      if (error instanceof AlreadyExistsError) {
        throw new Error("Python is already running for this conversation.");
      }
      throw error;
    }
    this.client = created.client;
    this.sandbox = created.sandbox;
    const venv = await runProcess(
      this.sandbox,
      ["sh", "-lc", `test -x ${VENV_PYTHON} || python3 -m venv ${WORKSPACE}/.venv`],
      { timeoutMs: PYTHON_TOOL_LIMITS.callTimeoutMs, deadlineAt },
    );
    if (venv.exitCode !== 0) throw new Error(venv.stderr || "Unable to initialize Python.");
    return this.sandbox;
  }

  async run(inputValue: unknown): Promise<ModalExecResult> {
    if (this.calls >= PYTHON_TOOL_LIMITS.maxCalls) {
      throw new Error("The response reached the 6-call Python limit.");
    }
    const callStartedAt = Date.now();
    if (callStartedAt >= this.responseDeadlineAt) {
      throw new Error("The response reached its 240-second execution limit.");
    }
    const input = validatePythonToolInput(inputValue);
    const callDeadlineAt = Math.min(
      this.responseDeadlineAt,
      callStartedAt + PYTHON_TOOL_LIMITS.callTimeoutMs,
    );
    assertDeadline(callDeadlineAt);
    this.calls += 1;
    const sandbox = await this.ensureSandbox(callDeadlineAt);
    const before = await snapshotFiles(sandbox, callDeadlineAt);

    if (input.packages?.length) {
      const install = await runProcess(
        sandbox,
        [VENV_PYTHON, "-m", "pip", "install", "--disable-pip-version-check", ...input.packages],
        { deadlineAt: callDeadlineAt },
      );
      if (install.exitCode !== 0) {
        return {
          stdout: install.stdout,
          stderr: install.stderr,
          exitCode: install.exitCode,
          stdoutTruncated: install.stdoutTruncated || undefined,
          stderrTruncated: install.stderrTruncated || undefined,
        };
      }
    }

    const command =
      input.code !== undefined
        ? [VENV_PYTHON, "-c", input.code, ...(input.args ?? [])]
        : [VENV_PYTHON, `${WORKSPACE}/${input.file}`, ...(input.args ?? [])];
    const execution = await runProcess(sandbox, command, { stdin: input.stdin, deadlineAt: callDeadlineAt });
    const after = await snapshotFiles(sandbox, callDeadlineAt);
    const requested = new Set(input.artifacts ?? []);
    const artifactCandidates = [...after.values()]
      .filter((item) => {
        const prior = before.get(item.path);
        return requested.has(item.path) || !prior || prior.size !== item.size || prior.mtimeNs !== item.mtimeNs;
      })
      .filter((item) => item.size <= PYTHON_TOOL_LIMITS.maxArtifactBytes)
      .slice(0, PYTHON_TOOL_LIMITS.maxArtifacts);
    const artifacts: ModalExecArtifact[] = [];
    let artifactBytes = 0;
    for (const item of artifactCandidates) {
      if (artifactBytes + item.size > PYTHON_TOOL_LIMITS.maxArtifactTotalBytes) break;
      assertDeadline(callDeadlineAt);
      const bytes = await waitForPythonDeadline(
        readBoundedArtifactBytes(sandbox, item.path, callDeadlineAt),
        callDeadlineAt,
        PYTHON_DEADLINE_ERROR,
      );
      if (artifactBytes + bytes.byteLength > PYTHON_TOOL_LIMITS.maxArtifactTotalBytes) break;
      artifacts.push({
        path: item.path,
        size: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      artifactBytes += bytes.byteLength;
    }
    return {
      stdout: execution.stdout,
      stderr: execution.stderr,
      exitCode: execution.exitCode,
      stdoutTruncated: execution.stdoutTruncated || undefined,
      stderrTruncated: execution.stderrTruncated || undefined,
      ...(artifacts.length ? { artifacts } : {}),
    };
  }

  async close(): Promise<void> {
    const sandbox = this.sandbox;
    this.sandbox = null;
    try {
      await sandbox?.terminate();
    } finally {
      this.client?.close();
      this.client = null;
    }
  }
}
