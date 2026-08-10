export const USER_MEMORY_ROOT_NAME = "User Profile";
export const USER_MEMORY_MAX_CONTENT_LENGTH = 2_000;
export const USER_MEMORY_MAX_FOLDER_NAME_LENGTH = 80;
export const USER_MEMORY_MAX_DEPTH = 8;
export const USER_MEMORY_MAX_PROFILE_LENGTH = 120_000;

export type UserMemoryWriter = "dreaming" | "agent";

export type UserMemoryFolder = {
  id: string;
  parentId: string | null;
  name: string;
  path: string[];
  createdAt: string;
};

export type UserMemory = {
  id: string;
  folderId: string;
  content: string;
  sensitive: boolean;
  sourceChatId: string;
  sourceJobId: string;
  writer: UserMemoryWriter;
  createdAt: string;
  updatedAt: string;
};

export type UserMemoryTree = {
  revision: number;
  folders: UserMemoryFolder[];
  memories: UserMemory[];
};

export type DreamingSource = {
  jobId: string;
  chatId: string;
  completedAt: string;
  summary: string;
};

export type DreamingAction =
  | { action: "create_folder"; path: string[]; sourceChatId: string }
  | { action: "add"; path: string[]; content: string; sensitive?: boolean; sourceChatId: string }
  | { action: "update"; memoryId: string; content: string; sensitive?: boolean; sourceChatId: string }
  | { action: "move"; memoryId: string; path: string[]; sourceChatId: string }
  | { action: "delete"; memoryId: string; sourceChatId: string }
  | { action: "noop"; reason: string };

export function normalizeMemoryText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function normalizeMemoryKey(value: string): string {
  return normalizeMemoryText(value).toLocaleLowerCase("en-US");
}

export function parseDreamingActions(value: unknown): DreamingAction[] {
  const root = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  const raw = root?.actions;
  if (!Array.isArray(raw) || raw.length > 100) throw new Error("Dreaming returned an invalid action list.");
  const actions: DreamingAction[] = raw.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Dreaming returned an invalid action.");
    const action = item as Record<string, unknown>;
    const type = action.action;
    const sourceChatId = typeof action.sourceChatId === "string" ? action.sourceChatId.trim() : "";
    const path = Array.isArray(action.path) && action.path.every((part) => typeof part === "string")
      ? (action.path as string[]).map(normalizeMemoryText).filter(Boolean)
      : null;
    const content = typeof action.content === "string" ? normalizeMemoryText(action.content) : "";
    if (action.sensitive !== undefined && typeof action.sensitive !== "boolean") throw new Error("Dreaming returned an invalid sensitivity flag.");
    const sensitive = action.sensitive as boolean | undefined;
    const memoryId = typeof action.memoryId === "string" ? action.memoryId.trim() : "";
    if (type === "noop") return { action: "noop", reason: typeof action.reason === "string" ? normalizeMemoryText(action.reason) : "" };
    if (!sourceChatId) throw new Error("Dreaming action provenance is missing.");
    if (type === "create_folder" && path) return { action: type, path, sourceChatId };
    if (type === "add" && path && content) return { action: type, path, content, ...(sensitive === undefined ? {} : { sensitive }), sourceChatId };
    if (type === "update" && memoryId && content) return { action: type, memoryId, content, ...(sensitive === undefined ? {} : { sensitive }), sourceChatId };
    if (type === "move" && memoryId && path) return { action: type, memoryId, path, sourceChatId };
    if (type === "delete" && memoryId) return { action: type, memoryId, sourceChatId };
    throw new Error("Dreaming returned an invalid action.");
  });
  return actions.length ? actions : [{ action: "noop", reason: "No durable profile changes." }];
}
