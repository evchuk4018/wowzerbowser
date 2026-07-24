import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { AlreadyExistsError, ModalClient, type ModalReadStream, type Sandbox } from "modal";
import type { PythonToolInput } from "../../../lib/chat-protocol";

export const PYTHON_TOOL_LIMITS = {
  cpu: 1,
  memoryMb: 1024,
  callTimeoutMs: 60_000,
  maxCalls: 6,
  responseTimeoutMs: 240_000,
  maxCodeLength: 64 * 1024,
  maxOutputLength: 64 * 1024,
  maxArtifacts: 20,
  maxArtifactBytes: 25 * 1024 * 1024,
  maxArtifactTotalBytes: 50 * 1024 * 1024,
} as const;

const APP_NAME = process.env.MODAL_APP_NAME?.trim() || "wowzerbowser-python";
const WORKSPACE = "/workspace";
const VENV_PYTHON = `${WORKSPACE}/.venv/bin/python`;
const PACKAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*(?:[<>=!~]=?[A-Za-z0-9.*+!-]+)?$/;

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
  if (!value || typeof value !== "object") throw new Error("run_python arguments must be an object.");
  const input = value as Record<string, unknown>;
  const hasCode = typeof input.code === "string" && input.code.trim().length > 0;
  const hasFile = typeof input.file === "string" && input.file.trim().length > 0;
  if (hasCode === hasFile) throw new Error("Provide exactly one of code or file.");
  if (hasCode && (input.code as string).length > PYTHON_TOOL_LIMITS.maxCodeLength) {
    throw new Error("code is too long.");
  }

  const packages = input.packages;
  if (packages !== undefined && (!Array.isArray(packages) || packages.length > 20)) {
    throw new Error("packages must contain at most 20 entries.");
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
      args.length > 32 ||
      args.some((arg) => typeof arg !== "string" || arg.length > 4_096))
  ) {
    throw new Error("args must contain at most 32 bounded strings.");
  }
  if (input.stdin !== undefined && (typeof input.stdin !== "string" || input.stdin.length > 64 * 1024)) {
    throw new Error("stdin is too long.");
  }
  const requestedArtifacts = input.artifacts;
  if (
    requestedArtifacts !== undefined &&
    (!Array.isArray(requestedArtifacts) || requestedArtifacts.length > PYTHON_TOOL_LIMITS.maxArtifacts)
  ) {
    throw new Error(`artifacts must contain at most ${PYTHON_TOOL_LIMITS.maxArtifacts} paths.`);
  }

  return {
    ...(hasCode ? { code: input.code as string } : {}),
    ...(hasFile ? { file: relativeWorkspacePath(input.file as string) } : {}),
    ...(normalizedPackages?.length ? { packages: normalizedPackages } : {}),
    ...(args ? { args: args as string[] } : {}),
    ...(typeof input.stdin === "string" ? { stdin: input.stdin } : {}),
    ...(requestedArtifacts
      ? { artifacts: requestedArtifacts.map((path) => relativeWorkspacePath(String(path))) }
      : {}),
  };
}

async function runProcess(
  sandbox: Sandbox,
  command: string[],
  options: { stdin?: string; timeoutMs?: number; outputLimit?: number } = {},
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}> {
  const process = await sandbox.exec(command, {
    workdir: WORKSPACE,
    timeoutMs: options.timeoutMs ?? PYTHON_TOOL_LIMITS.callTimeoutMs,
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

async function snapshotFiles(sandbox: Sandbox): Promise<Map<string, FileSnapshot>> {
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
  });
  if (result.exitCode !== 0) return new Map();
  const items = JSON.parse(result.stdout) as FileSnapshot[];
  return new Map(items.map((item) => [item.path, item]));
}

async function createWorkspaceSandbox(
  ownerId: string,
  conversationId: string,
  options: { readOnly?: boolean; name?: string; blockNetwork?: boolean } = {},
): Promise<{ client: ModalClient; sandbox: Sandbox }> {
  if (!isModalConfigured()) throw new Error("Modal Python execution is not configured.");
  const client = new ModalClient();
  try {
    const [app, volume] = await Promise.all([
      client.apps.fromName(APP_NAME, { createIfMissing: true }),
      client.volumes.fromName(conversationVolumeName(ownerId, conversationId), {
        createIfMissing: true,
      }),
    ]);
    const image = client.images.fromRegistry("python:3.13-slim");
    const sandbox = await client.sandboxes.create(app, image, {
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
    return { client, sandbox };
  } catch (error) {
    client.close();
    throw error;
  }
}

export async function readConversationArtifact(
  ownerId: string,
  conversationId: string,
  pathValue: string,
): Promise<Uint8Array> {
  const path = relativeWorkspacePath(pathValue);
  const { client, sandbox } = await createWorkspaceSandbox(ownerId, conversationId, {
    readOnly: true,
    blockNetwork: true,
    name: `chat-artifact-${randomUUID().replaceAll("-", "").slice(0, 24)}`,
  });
  try {
    const bytes = await sandbox.filesystem.readBytes(`${WORKSPACE}/${path}`);
    if (bytes.byteLength > PYTHON_TOOL_LIMITS.maxArtifactBytes) {
      throw new Error("Artifact exceeds the 25 MiB download limit.");
    }
    return bytes;
  } finally {
    await sandbox.terminate().catch(() => undefined);
    client.close();
  }
}

export class ModalPythonExecutor {
  private sandbox: Sandbox | null = null;
  private client: ModalClient | null = null;
  private calls = 0;
  private readonly startedAt = Date.now();

  constructor(
    private readonly ownerId: string,
    private readonly conversationId: string,
  ) {}

  private async ensureSandbox(): Promise<Sandbox> {
    if (this.sandbox) return this.sandbox;
    let created;
    try {
      // The deterministic name is a cross-instance lease: a second tab cannot
      // concurrently mutate the same persistent conversation volume.
      created = await createWorkspaceSandbox(this.ownerId, this.conversationId, {
        name: responseSandboxName(this.ownerId, this.conversationId),
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
      { timeoutMs: PYTHON_TOOL_LIMITS.callTimeoutMs },
    );
    if (venv.exitCode !== 0) throw new Error(venv.stderr || "Unable to initialize Python.");
    return this.sandbox;
  }

  async run(inputValue: unknown): Promise<ModalExecResult> {
    if (this.calls >= PYTHON_TOOL_LIMITS.maxCalls) {
      throw new Error("The response reached the 6-call Python limit.");
    }
    if (Date.now() - this.startedAt >= PYTHON_TOOL_LIMITS.responseTimeoutMs) {
      throw new Error("The response reached its 240-second execution limit.");
    }
    const input = validatePythonToolInput(inputValue);
    this.calls += 1;
    const sandbox = await this.ensureSandbox();
    const before = await snapshotFiles(sandbox);

    if (input.packages?.length) {
      const install = await runProcess(
        sandbox,
        [VENV_PYTHON, "-m", "pip", "install", "--disable-pip-version-check", ...input.packages],
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
    const execution = await runProcess(sandbox, command, { stdin: input.stdin });
    const after = await snapshotFiles(sandbox);
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
      const bytes = await sandbox.filesystem.readBytes(`${WORKSPACE}/${item.path}`);
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
