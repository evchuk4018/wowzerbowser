export const HOMELAB_OPENCODE_TOOL_NAME = "run_homelab_opencode" as const;

export const HOMELAB_OPENCODE_MAX_PROMPT_LENGTH = 12000;
export const HOMELAB_OPENCODE_DEFAULT_TIMEOUT_MS = 600_000;
export const HOMELAB_OPENCODE_MAX_CONCURRENT = 1;
export const HOMELAB_OPENCODE_MAX_CWD_LENGTH = 256;

export type HomelabOpencodeTurnStatus = "completed" | "error" | "timed_out" | "cancelled";

export type HomelabOpencodeRequest = {
  prompt: string;
  sessionId?: string;
  cwd?: string;
  agent?: string;
  model?: string;
};

export type HomelabOpencodeJsonEvent = {
  type: string;
  [key: string]: unknown;
};

export type HomelabOpencodeTurnResult = {
  sessionId: string;
  prompt: string;
  finalText: string;
  events: HomelabOpencodeJsonEvent[];
  status: HomelabOpencodeTurnStatus;
  endedWithQuestion: boolean;
  rawStdout: string;
  rawStderr: string;
  durationMs: number;
  exitCode: number | null;
  timedOut: boolean;
};

export function isHomelabOpencodeConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.HOMELAB_SSH_HOST?.trim() && env.HOMELAB_SSH_USER?.trim());
}

export function homelabOpencodeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): {
  host: string;
  user: string;
  keyFile: string | null;
  knownHostsFile: string | null;
  workdir: string;
  timeoutMs: number;
  maxConcurrent: number;
} {
  const host = env.HOMELAB_SSH_HOST?.trim() ?? "";
  const user = env.HOMELAB_SSH_USER?.trim() ?? "evanh";
  const keyFile = env.HOMELAB_SSH_KEY_FILE?.trim() || null;
  const knownHostsFile = env.HOMELAB_SSH_KNOWN_HOSTS?.trim() || null;
  const workdir = env.HOMELAB_WORKDIR?.trim() || "/srv/storage/wowzerbowser";
  const timeoutMs = (() => {
    const raw = Number.parseInt(env.HOMELAB_OPENCODE_TURN_TIMEOUT_MS ?? "", 10);
    if (!Number.isFinite(raw)) return HOMELAB_OPENCODE_DEFAULT_TIMEOUT_MS;
    return Math.max(10_000, Math.min(3_600_000, raw));
  })();
  const maxConcurrent = (() => {
    const raw = Number.parseInt(env.HOMELAB_OPENCODE_MAX_CONCURRENT ?? "", 10);
    if (!Number.isFinite(raw)) return HOMELAB_OPENCODE_MAX_CONCURRENT;
    return Math.max(1, Math.min(4, raw));
  })();
  return { host, user, keyFile, knownHostsFile, workdir, timeoutMs, maxConcurrent };
}

export function parseHomelabOpencodeRequest(value: unknown): HomelabOpencodeRequest {
  if (!value || typeof value !== "object") throw new Error("Invalid homelab opencode request.");
  const record = value as Record<string, unknown>;
  const prompt = typeof record.prompt === "string" ? record.prompt.trim() : "";
  if (!prompt) throw new Error("prompt is required.");
  if (prompt.length > HOMELAB_OPENCODE_MAX_PROMPT_LENGTH) throw new Error(`prompt must be ${HOMELAB_OPENCODE_MAX_PROMPT_LENGTH} characters or shorter.`);
  const sessionId = record.sessionId === undefined ? undefined : String(record.sessionId).trim() || undefined;
  if (sessionId !== undefined && !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) throw new Error("sessionId is invalid.");
  const cwd = record.cwd === undefined ? undefined : String(record.cwd).trim() || undefined;
  if (cwd !== undefined && cwd.length > HOMELAB_OPENCODE_MAX_CWD_LENGTH) throw new Error("cwd is too long.");
  if (cwd !== undefined && (cwd.includes("..") || cwd.startsWith("/"))) throw new Error("cwd must be a relative path without traversal.");
  const agent = record.agent === undefined ? undefined : String(record.agent).trim() || undefined;
  if (agent !== undefined && agent.length > 64) throw new Error("agent is too long.");
  const model = record.model === undefined ? undefined : String(record.model).trim() || undefined;
  if (model !== undefined && model.length > 128) throw new Error("model is too long.");
  return { prompt, ...(sessionId ? { sessionId } : {}), ...(cwd ? { cwd } : {}), ...(agent ? { agent } : {}), ...(model ? { model } : {}) };
}

export function detectHomelabEndedWithQuestion(text: string): boolean {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (!trimmed) return false;
  const stripped = trimmed.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "").trim();
  const lastSentence = stripped.split(/[.!]/).pop()?.trim() ?? "";
  if (!lastSentence) return false;
  return lastSentence.endsWith("?");
}

export function homelabOpencodeShellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
