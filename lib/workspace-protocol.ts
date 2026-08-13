import { relativeWorkspacePath } from "./python-tool-policy";

export const WORKSPACE_LIMITS = {
  maxPathLength: 512,
  maxSearchQueryLength: 200,
  maxSearchResults: 100,
  maxReadBytes: 256 * 1024,
  maxReadOutputLength: 256 * 1024,
  maxWriteBytes: 25 * 1024 * 1024,
  maxSearchFileBytes: 512 * 1024,
  maxCommandArgs: 32,
  maxCommandArgLength: 4_096,
  maxCommandTimeoutMs: 60_000,
  maxCommandOutputLength: 64 * 1024,
} as const;

export type WorkspaceFile = {
  path: string;
  name: string;
  size: number;
  contentType: string;
  language: string;
  editable: boolean;
  preview: "html" | "markdown" | "svg" | "image" | "text" | "none";
  sha256?: string;
};

export type WorkspaceSearchMatch = {
  path: string;
  line: number;
  column: number;
  excerpt: string;
};

export type WorkspaceChangedFile = Pick<WorkspaceFile, "path" | "size">;

export type WorkspaceCommandResult = {
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
  changedFiles?: WorkspaceChangedFile[];
};

export type WorkspaceReadInput = {
  path: string;
  startLine?: number;
  endLine?: number;
};

export type WorkspaceWriteInput = {
  path: string;
  content: string;
  expectedSha256?: string;
};

export type WorkspacePatchInput = {
  path: string;
  oldText?: string;
  newText?: string;
  patch?: string;
  expectedOccurrences?: number;
  expectedSha256?: string;
};

export type WorkspaceCommandInput = {
  command: string;
  args?: string[];
  cwd?: string;
  stdin?: string;
  timeoutMs?: number;
};

export function workspacePath(value: string): string {
  if (typeof value !== "string") throw new Error("Workspace path must be a string.");
  if (value.trim() === "" || value.trim() === ".") return "";
  const path = relativeWorkspacePath(value);
  if (path.length > WORKSPACE_LIMITS.maxPathLength) throw new Error("Workspace path is too long.");
  return path;
}

export function workspaceLanguage(path: string): string {
  const extension = path.toLowerCase().split(".").pop() ?? "";
  const languages: Record<string, string> = {
    html: "html", htm: "html", css: "css", js: "javascript", mjs: "javascript",
    cjs: "javascript", jsx: "javascriptreact", ts: "typescript", mts: "typescript",
    cts: "typescript", tsx: "typescriptreact", md: "markdown", markdown: "markdown",
    json: "json", py: "python", svg: "xml", xml: "xml", yaml: "yaml", yml: "yaml",
    sh: "shell", bash: "shell", txt: "plaintext", xlsx: "excel",
  };
  return languages[extension] ?? "plaintext";
}

export function workspaceContentType(path: string): string {
  const extension = path.toLowerCase().split(".").pop() ?? "";
  const types: Record<string, string> = {
    html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", css: "text/css; charset=utf-8",
    js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8", cjs: "text/javascript; charset=utf-8",
    jsx: "text/javascript; charset=utf-8", ts: "text/typescript; charset=utf-8", mts: "text/typescript; charset=utf-8",
    cts: "text/typescript; charset=utf-8", tsx: "text/typescript; charset=utf-8", md: "text/markdown; charset=utf-8",
    markdown: "text/markdown; charset=utf-8", json: "application/json", py: "text/x-python; charset=utf-8",
    svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", avif: "image/avif", ico: "image/x-icon",
    xml: "application/xml", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", yaml: "text/yaml; charset=utf-8", yml: "text/yaml; charset=utf-8",
    sh: "text/x-shellscript; charset=utf-8", bash: "text/x-shellscript; charset=utf-8", txt: "text/plain; charset=utf-8",
  };
  return types[extension] ?? "text/plain; charset=utf-8";
}

export function workspacePreview(path: string, contentType = workspaceContentType(path)): WorkspaceFile["preview"] {
  if (contentType.startsWith("text/html")) return "html";
  if (contentType === "text/markdown; charset=utf-8") return "markdown";
  if (contentType === "image/svg+xml") return "svg";
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("text/") || contentType === "application/json" || contentType === "application/xml") return "text";
  return "none";
}

export function workspaceFileFor(pathValue: string, size: number, sha256?: string): WorkspaceFile {
  const path = workspacePath(pathValue);
  const name = path.split("/").pop() ?? path;
  const contentType = workspaceContentType(path);
  return {
    path,
    name,
    size,
    contentType,
    language: workspaceLanguage(path),
    editable: contentType.startsWith("text/") || contentType === "application/json" || contentType === "application/xml" || contentType === "image/svg+xml",
    preview: workspacePreview(path, contentType),
    ...(sha256 ? { sha256 } : {}),
  };
}
