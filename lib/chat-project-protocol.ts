export const CHAT_PROJECT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const CHAT_PROJECT_FILE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const CHAT_PROJECT_LIMITS = {
  maxIdLength: 128,
  maxTitleLength: 160,
  maxInstructionsLength: 12_000,
  maxChatTitleLength: 160,
  maxFilenameLength: 512,
  maxContentTypeLength: 255,
  maxFileSizeBytes: 100 * 1024 * 1024,
  maxFiles: 1_000,
} as const;

export const CHAT_PROJECT_FILE_STATES = ["uploading", "complete", "failed"] as const;
export type ChatProjectFileState = (typeof CHAT_PROJECT_FILE_STATES)[number];

export type ChatProject = {
  id: string;
  title: string;
  instructions: string;
  createdAt: string;
  updatedAt: string;
};

export type ChatProjectChat = {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  hasMessages: boolean;
  isStreaming: boolean;
};

/** Public metadata only; storage keys and owner identifiers never cross this boundary. */
export type ChatProjectFileMetadata = {
  id: string;
  projectId: string;
  name: string;
  contentType: string;
  size: number;
  sha256: string | null;
  state: ChatProjectFileState;
  createdAt: string;
};

export type CreateChatProjectInput = {
  title: string;
  instructions: string;
};

export type UpdateChatProjectInput = {
  title?: string;
  instructions?: string;
};

export type CreateChatProjectChatInput = {
  title?: string;
  conversationId?: string;
};

export class ChatProjectProtocolError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isChatProjectId(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= CHAT_PROJECT_LIMITS.maxIdLength
    && CHAT_PROJECT_ID_PATTERN.test(value);
}

export function validateChatProjectId(value: unknown, label = "project identifier"): string {
  if (!isChatProjectId(value)) throw new ChatProjectProtocolError(`${label} is invalid.`);
  return value;
}

export function isChatProjectFileId(value: unknown): value is string {
  return typeof value === "string" && CHAT_PROJECT_FILE_ID_PATTERN.test(value);
}

export function validateChatProjectTitle(value: unknown, label = "project title"): string {
  if (typeof value !== "string") throw new ChatProjectProtocolError(`${label} must be a string.`);
  const title = value.trim();
  if (!title || title.length > CHAT_PROJECT_LIMITS.maxTitleLength) {
    throw new ChatProjectProtocolError(`${label} must contain 1 to ${CHAT_PROJECT_LIMITS.maxTitleLength} characters.`);
  }
  return title;
}

export function validateChatProjectInstructions(value: unknown): string {
  if (typeof value !== "string" || value.length > CHAT_PROJECT_LIMITS.maxInstructionsLength) {
    throw new ChatProjectProtocolError(`Project instructions must contain at most ${CHAT_PROJECT_LIMITS.maxInstructionsLength} characters.`);
  }
  return value.trim();
}

export function parseCreateChatProjectInput(value: unknown): CreateChatProjectInput {
  if (!isRecord(value)) throw new ChatProjectProtocolError("Project body must be an object.");
  return {
    title: validateChatProjectTitle(value.title),
    instructions: value.instructions === undefined ? "" : validateChatProjectInstructions(value.instructions),
  };
}

export function parseUpdateChatProjectInput(value: unknown): UpdateChatProjectInput {
  if (!isRecord(value)) throw new ChatProjectProtocolError("Project body must be an object.");
  const hasTitle = value.title !== undefined;
  const hasInstructions = value.instructions !== undefined;
  if (!hasTitle && !hasInstructions) throw new ChatProjectProtocolError("Project updates must include a title or instructions.");
  return {
    ...(hasTitle ? { title: validateChatProjectTitle(value.title) } : {}),
    ...(hasInstructions ? { instructions: validateChatProjectInstructions(value.instructions) } : {}),
  };
}

export function parseCreateChatProjectChatInput(value: unknown): CreateChatProjectChatInput {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new ChatProjectProtocolError("Chat body must be an object.");
  const conversationId = value.conversationId === undefined
    ? undefined
    : validateChatProjectId(value.conversationId, "conversation identifier");
  const title = value.title === undefined ? undefined : validateChatProjectTitle(value.title, "chat title");
  return { ...(title === undefined ? {} : { title }), ...(conversationId === undefined ? {} : { conversationId }) };
}

export function validateChatProjectFileMetadata(value: unknown): ChatProjectFileMetadata {
  if (!isRecord(value)) throw new ChatProjectProtocolError("Project file metadata must be an object.");
  const id = value.id;
  const projectId = value.projectId;
  const name = value.name;
  const contentType = value.contentType;
  const size = value.size;
  const sha256 = value.sha256;
  const state = value.state;
  const createdAt = value.createdAt;
  if (!isChatProjectFileId(id) || !isChatProjectId(projectId)) throw new ChatProjectProtocolError("Project file identifiers are invalid.");
  if (typeof name !== "string" || !name.trim() || name.length > CHAT_PROJECT_LIMITS.maxFilenameLength) throw new ChatProjectProtocolError("Project file name is invalid.");
  if (typeof contentType !== "string" || !contentType.trim() || contentType.length > CHAT_PROJECT_LIMITS.maxContentTypeLength) throw new ChatProjectProtocolError("Project file content type is invalid.");
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 || size > CHAT_PROJECT_LIMITS.maxFileSizeBytes) throw new ChatProjectProtocolError("Project file size is invalid.");
  if (sha256 !== null && (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(sha256))) throw new ChatProjectProtocolError("Project file checksum is invalid.");
  if (!CHAT_PROJECT_FILE_STATES.includes(state as ChatProjectFileState)) throw new ChatProjectProtocolError("Project file state is invalid.");
  if (typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt))) throw new ChatProjectProtocolError("Project file creation time is invalid.");
  return {
    id,
    projectId,
    name: name.trim(),
    contentType: contentType.trim(),
    size,
    sha256: sha256 as string | null,
    state: state as ChatProjectFileState,
    createdAt,
  };
}
