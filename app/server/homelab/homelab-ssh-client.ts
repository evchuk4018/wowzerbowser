import "server-only";

import { spawn } from "node:child_process";
import { homelabOpencodeConfigFromEnv, homelabOpencodeShellEscape } from "../../../lib/homelab-opencode-protocol";

export type HomelabSshSpawnResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
};

export type HomelabSshStreamHandlers = {
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
};

function buildRemoteCommand(prompt: string, options: { sessionId?: string; cwd?: string; agent?: string; model?: string; workdir: string }): string {
  const parts: string[] = [];
  const workdir = options.cwd ? `${options.workdir}/${options.cwd}` : options.workdir;
  parts.push(`cd ${homelabOpencodeShellEscape(workdir)}`);
  const opencodeArgs: string[] = ["opencode", "run", "--format", "json", "--auto"];
  if (options.sessionId) {
    opencodeArgs.push("--session", homelabOpencodeShellEscape(options.sessionId));
    opencodeArgs.push("--continue");
  }
  if (options.agent) opencodeArgs.push("--agent", homelabOpencodeShellEscape(options.agent));
  if (options.model) opencodeArgs.push("--model", homelabOpencodeShellEscape(options.model));
  opencodeArgs.push(homelabOpencodeShellEscape(prompt));
  parts.push(opencodeArgs.join(" "));
  return parts.join(" && ");
}

export function buildHomelabSshInvocation(prompt: string, options: { sessionId?: string; cwd?: string; agent?: string; model?: string }): { command: string; args: string[]; remoteCommand: string } {
  const config = homelabOpencodeConfigFromEnv();
  if (!config.host) throw new Error("HOMELAB_SSH_HOST is not configured.");
  const remoteCommand = buildRemoteCommand(prompt, {
    sessionId: options.sessionId,
    cwd: options.cwd,
    agent: options.agent,
    model: options.model,
    workdir: config.workdir,
  });
  const args: string[] = [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "StrictHostKeyChecking=accept-new",
  ];
  if (config.keyFile) args.push("-i", config.keyFile);
  if (config.knownHostsFile) args.push("-o", `UserKnownHostsFile=${config.knownHostsFile}`);
  args.push(`${config.user}@${config.host}`, remoteCommand);
  return { command: "ssh", args, remoteCommand };
}

export async function spawnHomelabSsh(
  prompt: string,
  options: { sessionId?: string; cwd?: string; agent?: string; model?: string; signal?: AbortSignal; timeoutMs?: number },
  handlers: HomelabSshStreamHandlers = {},
): Promise<HomelabSshSpawnResult> {
  const config = homelabOpencodeConfigFromEnv();
  const timeoutMs = options.timeoutMs ?? config.timeoutMs;
  const { command, args } = buildHomelabSshInvocation(prompt, { sessionId: options.sessionId, cwd: options.cwd, agent: options.agent, model: options.model });
  return spawnWithStreaming(command, args, { signal: options.signal, timeoutMs }, handlers);
}

function spawnWithStreaming(
  command: string,
  args: string[],
  options: { signal?: AbortSignal; timeoutMs: number },
  handlers: HomelabSshStreamHandlers,
): Promise<HomelabSshSpawnResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let timedOut = false;
    const child = spawn(command, args, { signal: options.signal, windowsHide: true });
    let timeout: NodeJS.Timeout | null = null;
    if (options.timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, 5_000).unref?.();
      }, options.timeoutMs);
      timeout.unref?.();
    }
    const onAbort = () => {
      child.kill("SIGTERM");
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      stdoutBuffer += text;
      let newlineIndex: number;
      while ((newlineIndex = stdoutBuffer.indexOf("\n")) !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex);
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (line.trim()) handlers.onStdoutLine?.(line);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      stderrBuffer += text;
      let newlineIndex: number;
      while ((newlineIndex = stderrBuffer.indexOf("\n")) !== -1) {
        const line = stderrBuffer.slice(0, newlineIndex);
        stderrBuffer = stderrBuffer.slice(newlineIndex + 1);
        if (line.trim()) handlers.onStderrLine?.(line);
      }
    });
    child.on("error", (error) => {
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      if (stdoutBuffer.trim()) handlers.onStdoutLine?.(stdoutBuffer);
      if (stderrBuffer.trim()) handlers.onStderrLine?.(stderrBuffer);
      if (options.signal?.aborted && !timedOut) {
        resolve({ stdout, stderr: stderr || `Aborted via signal: ${String(options.signal.reason ?? signal ?? "abort")}`, exitCode: code, timedOut: false });
        return;
      }
      resolve({ stdout, stderr, exitCode: code, timedOut });
    });
  });
}
