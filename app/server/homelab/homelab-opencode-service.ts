import "server-only";

import { randomUUID } from "node:crypto";
import {
  detectHomelabEndedWithQuestion,
  homelabOpencodeConfigFromEnv,
  isHomelabOpencodeConfigured,
  type HomelabOpencodeJsonEvent,
  type HomelabOpencodeRequest,
  type HomelabOpencodeTurnResult,
} from "../../../lib/homelab-opencode-protocol";
import { spawnHomelabSsh } from "./homelab-ssh-client";

export type HomelabOpencodeServiceHooks = {
  spawn?: typeof spawnHomelabSsh;
  now?: () => number;
};

type HomelabSpawn = typeof spawnHomelabSsh;

let semaphore: Promise<void> = Promise.resolve();

async function withSemaphore<T>(limit: number, operation: () => Promise<T>): Promise<T> {
  if (limit <= 1) {
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    const previous = semaphore;
    semaphore = next;
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
  return operation();
}

function parseJsonEvents(stdout: string, collected: HomelabOpencodeJsonEvent[], rawLines: string[]): void {
  for (const line of rawLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as HomelabOpencodeJsonEvent;
      if (parsed && typeof parsed === "object" && typeof parsed.type === "string") {
        collected.push(parsed);
      } else {
        collected.push({ type: "text", text: trimmed, raw: trimmed });
      }
    } catch {
      collected.push({ type: "text", text: trimmed, raw: trimmed });
    }
  }
}

function extractFinalText(events: HomelabOpencodeJsonEvent[], rawStdout: string): string {
  const getPartText = (event: HomelabOpencodeJsonEvent): string | null => {
    if (typeof event.text === "string" && event.text.trim()) return String(event.text).trim();
    const part = (event as unknown as { part?: unknown }).part;
    if (part && typeof part === "object") {
      const record = part as Record<string, unknown>;
      if (typeof record.text === "string" && String(record.text).trim()) return String(record.text).trim();
      if (typeof record.content === "string" && String(record.content).trim()) return String(record.content).trim();
    }
    if (typeof event.content === "string" && String(event.content).trim()) return String(event.content).trim();
    if (typeof event.message === "string" && String(event.message).trim()) return String(event.message).trim();
    if (typeof event.delta === "string" && String(event.delta).trim()) return String(event.delta).trim();
    return null;
  };
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const candidate = getPartText(events[index]);
    if (candidate) return candidate;
  }
  const nonJsonText = events
    .map((event) => getPartText(event))
    .filter((text): text is string => Boolean(text))
    .join("\n")
    .trim();
  if (nonJsonText) return nonJsonText.slice(0, 48_000);
  const fallback = rawStdout.trim().split("\n").filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    try { JSON.parse(trimmed); return false; } catch { return true; }
  }).join("\n").trim();
  return fallback.slice(0, 48_000);
}

export async function runHomelabOpencodeTurn(
  request: HomelabOpencodeRequest,
  options: { signal?: AbortSignal; timeoutMs?: number; onEvent?: (event: HomelabOpencodeJsonEvent) => void } = {},
  hooks: HomelabOpencodeServiceHooks = {},
): Promise<HomelabOpencodeTurnResult> {
  if (!isHomelabOpencodeConfigured()) throw new Error("Homelab opencode is not configured. Set HOMELAB_SSH_HOST and HOMELAB_SSH_USER.");
  const config = homelabOpencodeConfigFromEnv();
  const spawn: HomelabSpawn = hooks.spawn ?? spawnHomelabSsh;
  const now = hooks.now ?? Date.now;
  const startedAt = now();
  const requestedSessionId = request.sessionId ?? null;
  const timeoutMs = options.timeoutMs ?? config.timeoutMs;
  return withSemaphore(config.maxConcurrent, async () => {
    const events: HomelabOpencodeJsonEvent[] = [];
    const rawLines: string[] = [];
    const result = await spawn(
      request.prompt,
      { ...(requestedSessionId ? { sessionId: requestedSessionId } : {}), cwd: request.cwd, agent: request.agent, model: request.model, signal: options.signal, timeoutMs },
      {
        onStdoutLine: (line) => {
          rawLines.push(line);
          const trimmed = line.trim();
          if (!trimmed) return;
          try {
            const parsed = JSON.parse(trimmed) as HomelabOpencodeJsonEvent;
            const event = parsed && typeof parsed === "object" && typeof parsed.type === "string" ? parsed : { type: "text", text: trimmed, raw: trimmed };
            events.push(event);
            options.onEvent?.(event);
          } catch {
            const event: HomelabOpencodeJsonEvent = { type: "text", text: trimmed, raw: trimmed };
            events.push(event);
            options.onEvent?.(event);
          }
        },
        onStderrLine: () => undefined,
      },
    );
    const durationMs = now() - startedAt;
    const rawStdout = result.stdout;
    const rawStderr = result.stderr;
    if (!events.length && rawStdout.trim()) {
      parseJsonEvents(rawStdout, events, rawStdout.split("\n"));
    }
    const finalText = extractFinalText(events, rawStdout);
    const endedWithQuestion = detectHomelabEndedWithQuestion(finalText);
    let status: HomelabOpencodeTurnResult["status"] = "completed";
    if (result.timedOut) status = "timed_out";
    else if (options.signal?.aborted) status = "cancelled";
    else if (result.exitCode !== 0 && result.exitCode !== null) {
      const hasErrorEvent = events.some((event) => event.type === "error");
      if (hasErrorEvent || !finalText) status = "error";
    }
    if (result.timedOut && !finalText && !events.length) {
      events.push({ type: "error", message: `Homelab opencode timed out after ${timeoutMs}ms.` });
    }
    const sessionIdFromEvents = (() => {
      for (const event of events) {
        const candidate = (event as unknown as { sessionID?: unknown; sessionId?: unknown }).sessionID ?? (event as unknown as { sessionId?: unknown }).sessionId;
        if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
        const part = (event as unknown as { part?: unknown }).part;
        if (part && typeof part === "object") {
          const record = part as Record<string, unknown>;
          if (typeof record.sessionID === "string" && record.sessionID.trim()) return record.sessionID.trim();
          if (typeof record.sessionId === "string" && record.sessionId.trim()) return record.sessionId.trim();
        }
      }
      return null;
    })();
    const resolvedSessionId = requestedSessionId ?? sessionIdFromEvents ?? randomUUID();
    return {
      sessionId: resolvedSessionId,
      prompt: request.prompt,
      finalText: finalText || (status === "error" ? (rawStderr.slice(0, 4_000) || "Homelab opencode failed without output.") : ""),
      events,
      status,
      endedWithQuestion,
      rawStdout: rawStdout.slice(0, 200_000),
      rawStderr: rawStderr.slice(0, 20_000),
      durationMs,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
    };
  });
}

export function resetHomelabOpencodeSemaphoreForTests(): void {
  semaphore = Promise.resolve();
}
