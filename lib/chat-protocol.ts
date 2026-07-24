export const CHAT_MODEL_IDS = ["deepseek-v4-flash", "deepseek-v4-pro"] as const;
export type ChatModelId = (typeof CHAT_MODEL_IDS)[number];
const MAX_PROMPT_LENGTH = 12000;
const MAX_TRACE_LENGTH = 128 * 1024;
const MAX_MESSAGES = 100;
const MAX_SERIALIZED_HISTORY_LENGTH = 1024 * 1024;

export type ChatReasoningEffort = "high" | "max";

export type ChatMessageInput = {
  role: "user" | "assistant";
  content: string;
  /** Provider-neutral replay information for prior assistant tool rounds. */
  reasoning?: string;
  toolCalls?: ChatToolCall[];
  rounds?: ChatAssistantRound[];
};

/** A provider-neutral message appended after a tool call. */
export type ChatToolMessageInput = {
  role: "tool";
  content: string;
  toolCallId: string;
  name?: string;
};

export type PythonToolInput = {
  /** Inline Python source. Exactly one of code and file is required. */
  code?: string;
  /** Existing relative path in the conversation volume. */
  file?: string;
  packages?: string[];
  args?: string[];
  stdin?: string;
  artifacts?: string[];
};

export type ChatToolCall = {
  id: string;
  name: string;
  arguments: string;
  result?: ChatToolResult;
};

export type ChatAssistantRound = {
  reasoning?: string;
  content: string;
  toolCalls?: ChatToolCall[];
};

export type ChatArtifact = {
  id: string;
  name: string;
  contentType: string;
  size: number;
};

export type ChatToolResult = {
  id: string;
  name: string;
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode?: number;
  durationMs?: number;
  timedOut?: boolean;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  artifacts?: ChatArtifact[];
};

export type ChatRequest = {
  systemPrompt: string;
  userPresence: string;
  messages: ChatMessageInput[];
  model: ChatModelId;
  thinking: boolean;
  reasoningEffort: ChatReasoningEffort;
  /** Stable client-generated id used to persist the execution volume. */
  conversationId?: string;
};

export type ChatModelInfo = {
  id: ChatModelId;
  label: string;
  thinkingSupported: boolean;
  supportedEfforts: ChatReasoningEffort[];
};

export type ChatStreamEvent =
  | { type: "round"; round: number }
  | { type: "reasoning"; delta: string }
  | { type: "content"; delta: string }
  | { type: "tool_call"; call: ChatToolCall }
  | { type: "tool_result"; result: ChatToolResult }
  | { type: "artifact"; artifact: ChatArtifact }
  | {
      type: "meta";
      model: ChatModelId;
      thinking: boolean;
      reasoningEffort: ChatReasoningEffort;
      responseId?: string;
      tools?: string[];
    }
  | { type: "done"; usage: ChatUsage | null }
  | { type: "error"; message: string };

export type ChatUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
};

export class ChatRequestValidationError extends Error {}

export const DEFAULT_CHAT_MODELS: ChatModelInfo[] = [
  {
    id: "deepseek-v4-flash",
    label: "V4 Flash",
    thinkingSupported: true,
    supportedEfforts: ["high", "max"],
  },
  {
    id: "deepseek-v4-pro",
    label: "V4 Pro",
    thinkingSupported: true,
    supportedEfforts: ["high", "max"],
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ChatRequestValidationError(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

function readString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new ChatRequestValidationError(`${field} must be a string.`);
  }
  const result = value.trim();
  if (result.length > MAX_PROMPT_LENGTH) {
    throw new ChatRequestValidationError(`${field} is too long.`);
  }
  return result;
}

function readTraceString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new ChatRequestValidationError(`${field} must be a string.`);
  }
  if (value.length > MAX_TRACE_LENGTH) {
    throw new ChatRequestValidationError(`${field} is too long.`);
  }
  return value;
}

function readToolCalls(value: unknown, field: string): ChatToolCall[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 6) {
    throw new ChatRequestValidationError(`${field} must be an array with at most 6 calls.`);
  }
  return value.map((call, index) => {
    if (!isRecord(call)) throw new ChatRequestValidationError(`${field}[${index}] is invalid.`);
    let result: ChatToolResult | undefined;
    if (call.result !== undefined) {
      if (!isRecord(call.result)) throw new ChatRequestValidationError(`${field}[${index}].result is invalid.`);
      if (typeof call.result.ok !== "boolean") throw new ChatRequestValidationError(`${field}[${index}].result.ok is invalid.`);
      result = {
        id: readNonEmptyString(call.result.id, `${field}[${index}].result.id`),
        name: readNonEmptyString(call.result.name, `${field}[${index}].result.name`),
        ok: call.result.ok,
        stdout: readTraceString(call.result.stdout, `${field}[${index}].result.stdout`),
        stderr: readTraceString(call.result.stderr, `${field}[${index}].result.stderr`),
        ...(typeof call.result.exitCode === "number" ? { exitCode: call.result.exitCode } : {}),
        ...(typeof call.result.durationMs === "number" ? { durationMs: call.result.durationMs } : {}),
        ...(typeof call.result.timedOut === "boolean" ? { timedOut: call.result.timedOut } : {}),
        ...(typeof call.result.stdoutTruncated === "boolean"
          ? { stdoutTruncated: call.result.stdoutTruncated }
          : {}),
        ...(typeof call.result.stderrTruncated === "boolean"
          ? { stderrTruncated: call.result.stderrTruncated }
          : {}),
        ...(Array.isArray(call.result.artifacts)
          ? {
              artifacts: call.result.artifacts.slice(0, 20).map((artifact, artifactIndex) => {
                if (!isRecord(artifact)) {
                  throw new ChatRequestValidationError(
                    `${field}[${index}].result.artifacts[${artifactIndex}] is invalid.`,
                  );
                }
                const size = artifact.size;
                if (typeof size !== "number" || !Number.isFinite(size) || size < 0) {
                  throw new ChatRequestValidationError(
                    `${field}[${index}].result.artifacts[${artifactIndex}].size is invalid.`,
                  );
                }
                return {
                  id: readNonEmptyString(
                    artifact.id,
                    `${field}[${index}].result.artifacts[${artifactIndex}].id`,
                  ),
                  name: readNonEmptyString(
                    artifact.name,
                    `${field}[${index}].result.artifacts[${artifactIndex}].name`,
                  ),
                  contentType: readNonEmptyString(
                    artifact.contentType,
                    `${field}[${index}].result.artifacts[${artifactIndex}].contentType`,
                  ),
                  size,
                };
              }),
            }
          : {}),
      };
    }
    return {
      id: readNonEmptyString(call.id, `${field}[${index}].id`),
      name: readNonEmptyString(call.name, `${field}[${index}].name`),
      arguments: readString(call.arguments, `${field}[${index}].arguments`),
      ...(result ? { result } : {}),
    };
  });
}

function readRounds(value: unknown, field: string): ChatAssistantRound[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 7) {
    throw new ChatRequestValidationError(`${field} must be an array with at most 7 rounds.`);
  }
  return value.map((round, index) => {
    if (!isRecord(round)) throw new ChatRequestValidationError(`${field}[${index}] is invalid.`);
    const reasoning =
      round.reasoning === undefined
        ? undefined
        : readTraceString(round.reasoning, `${field}[${index}].reasoning`);
    const content = readTraceString(round.content, `${field}[${index}].content`);
    const toolCalls = readToolCalls(round.toolCalls, `${field}[${index}].toolCalls`);
    return {
      content,
      ...(reasoning === undefined ? {} : { reasoning }),
      ...(toolCalls === undefined ? {} : { toolCalls }),
    };
  });
}

export function parseChatRequest(value: unknown): ChatRequest {
  if (!isRecord(value) || !Array.isArray(value.messages)) {
    throw new ChatRequestValidationError("messages must be an array.");
  }
  if (value.messages.length > MAX_MESSAGES) {
    throw new ChatRequestValidationError(`messages must contain at most ${MAX_MESSAGES} entries.`);
  }
  if (JSON.stringify(value.messages).length > MAX_SERIALIZED_HISTORY_LENGTH) {
    throw new ChatRequestValidationError("message history is too large.");
  }

  const systemPrompt = readNonEmptyString(value.systemPrompt, "systemPrompt");
  const userPresence = readString(value.userPresence, "userPresence");

  const messages = value.messages.map((message, index) => {
    if (!isRecord(message) || (message.role !== "user" && message.role !== "assistant")) {
      throw new ChatRequestValidationError(`messages[${index}].role is invalid.`);
    }
    const reasoning = message.reasoning === undefined
      ? undefined
      : readString(message.reasoning, `messages[${index}].reasoning`);
    const toolCalls = readToolCalls(message.toolCalls, `messages[${index}].toolCalls`);
    const rounds = readRounds(message.rounds, `messages[${index}].rounds`);
    if (message.role === "user" && (reasoning !== undefined || toolCalls !== undefined || rounds !== undefined)) {
      throw new ChatRequestValidationError(`messages[${index}] tool trace is only valid for assistant messages.`);
    }
    return {
      role: message.role,
      content: readNonEmptyString(message.content, `messages[${index}].content`),
      ...(reasoning === undefined ? {} : { reasoning }),
      ...(toolCalls === undefined ? {} : { toolCalls }),
      ...(rounds === undefined ? {} : { rounds }),
    } as ChatMessageInput;
  });

  if (!messages.length || messages[messages.length - 1].role !== "user") {
    throw new ChatRequestValidationError("messages must end with a user message.");
  }

  if (!CHAT_MODEL_IDS.includes(value.model as ChatModelId)) {
    throw new ChatRequestValidationError("model is not supported.");
  }

  if (typeof value.thinking !== "boolean") {
    throw new ChatRequestValidationError("thinking must be a boolean.");
  }

  if (value.reasoningEffort !== "high" && value.reasoningEffort !== "max") {
    throw new ChatRequestValidationError("reasoningEffort must be high or max.");
  }

  let conversationId: string | undefined;
  if (value.conversationId !== undefined) {
    if (typeof value.conversationId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.conversationId)) {
      throw new ChatRequestValidationError("conversationId is invalid.");
    }
    conversationId = value.conversationId;
  }

  return {
    systemPrompt,
    userPresence,
    messages,
    model: value.model as ChatModelId,
    thinking: value.thinking,
    reasoningEffort: value.reasoningEffort,
    conversationId,
  };
}
