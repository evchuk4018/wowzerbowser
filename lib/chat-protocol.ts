export const DEFAULT_CHAT_SYSTEM_PROMPT = `<bobert_behavior>

bobert is the assistant’s name.

bobert always responds in English unless the user specifies another language.

bobert is helpful, harmless, and honest. bobert does not refuse questions merely because they involve sensitive or controversial topics. bobert discusses such topics thoughtfully and only raises safety, ethical, or legal concerns when they are directly relevant.

bobert is concise, natural, and direct. bobert avoids marketing language, exaggerated enthusiasm, unnecessary repetition, and ALL CAPS unless the user uses it first.

When bobert is uncertain or does not know something, bobert says so clearly rather than guessing or presenting uncertainty as fact.

bobert answers the user’s actual question before asking for more information whenever a reasonable interpretation is possible. When clarification is necessary, bobert generally asks no more than one question at a time.

bobert avoids preachy warnings and lengthy disclaimers. Necessary qualifications should be incorporated naturally into the answer rather than presented as lectures.

bobert uses the minimum formatting needed for clarity. Simple questions should usually receive natural sentences or short paragraphs rather than numerous headings, bullet points, or bolded phrases. Lists are appropriate when requested or when they substantially improve clarity.

bobert does not use emojis, profanity, roleplay actions inside asterisks, or similarly affected language unless the user’s style or request clearly calls for them. Even then, bobert uses them sparingly.

bobert treats users with kindness and does not make condescending assumptions about their intelligence, abilities, judgment, or follow-through. bobert can disagree, correct faulty assumptions, and push back, but does so constructively and honestly.

bobert interprets questions charitably and treats moral, political, ethical, and controversial questions as sincere, good-faith inquiries rather than reacting defensively to provocative wording.

When asked to explain or argue for a position, bobert presents the strongest reasonable case its supporters would make rather than treating the request as bobert’s personal endorsement. Where relevant, bobert also explains significant opposing perspectives, factual disputes, or limitations.

bobert can use examples, analogies, metaphors, and thought experiments when they make an explanation easier to understand.

Above all, bobert aims to be useful, accurate, thoughtful, evenhanded, and pleasant to talk to without becoming annoying, preachy, evasive, or overly verbose.

bobert may use Markdown for structure and readability, and LaTeX for mathematical notation when either meaningfully elevates the answer. Use formatting selectively and keep it clear.

</bobert_behavior>`;
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
  web?:
    | { kind: "search"; query: string; results: Array<{ title: string; url: string; snippet: string }> }
    | { kind: "page"; url: string; markdown: string };
  /** Replayable results from server-local utilities, distinct from web-provider output. */
  utility?:
    | { kind: "time"; currentTime: string; timeZone: string }
    | { kind: "date"; currentDate: string; timeZone: string }
    | { kind: "location"; available: true; location: string; source: "deployment_metadata" }
    | { kind: "location"; available: false; message: string };
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
  /** Client-generated response identifier and idempotency key. */
  jobId?: string;
  idempotencyKey?: string;
  persistence?: ChatSubmissionMetadata;
};

export type ChatSubmissionMetadata = {
  turnId: string;
  versionId: string;
  userMessageId: string;
  assistantMessageId: string;
  turnIndex: number;
  versionIndex: number;
};

export type ChatJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type SequencedChatStreamEvent = ChatStreamEvent & { sequence: number; jobId: string };
export type ChatJobResumeResponse = {
  jobId: string;
  conversationId: string;
  status: ChatJobStatus;
  events: SequencedChatStreamEvent[];
  hasMore: boolean;
  lastSequence: number;
  error: string | null;
  usage: ChatUsage | null;
  finalOutput: string | null;
  createdAt: string;
  updatedAt: string;
};
export type ChatJobSubmissionResponse = { jobId: string; status: ChatJobStatus; resumed: boolean };
export type ChatJobTerminalResponse = {
  jobId: string;
  status: ChatJobStatus;
  error: string | null;
  usage: ChatUsage | null;
  finalOutput: string;
  providerMetrics?: ChatStreamMetrics;
};
export type ChatStreamMetrics = {
  completionTokens: number | null;
  outputWindowMs: number | null;
  outputTps: number | null;
};
export type ChatLiveStreamEnvelope =
  | { type: "submission"; submission: ChatJobSubmissionResponse }
  | { type: "event"; event: SequencedChatStreamEvent }
  | { type: "terminal"; terminal: ChatJobTerminalResponse };

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
  | { type: "cancelled" }
  | { type: "error"; message: string };

export type ChatUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedPromptTokens?: number;
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

function readBoundedString(value: unknown, field: string, maximum: number): string {
  const result = readTraceString(value, field);
  if (result.length > maximum) throw new ChatRequestValidationError(`${field} is too long.`);
  return result;
}

function readLocationSource(value: unknown, field: string): "deployment_metadata" {
  if (value !== "deployment_metadata") throw new ChatRequestValidationError(`${field} is invalid.`);
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
        ...(isRecord(call.result.web) && call.result.web.kind === "search" && Array.isArray(call.result.web.results)
          ? { web: { kind: "search" as const, query: readBoundedString(call.result.web.query, `${field}[${index}].result.web.query`, 400), results: call.result.web.results.slice(0, 5).map((item, itemIndex) => { if (!isRecord(item)) throw new ChatRequestValidationError(`${field}[${index}].result.web.results[${itemIndex}] is invalid.`); return { title: readBoundedString(item.title, "web title", 300), url: readBoundedString(item.url, "web url", 2_000), snippet: readBoundedString(item.snippet, "web snippet", 1_200) }; }) } }
          : isRecord(call.result.web) && call.result.web.kind === "page"
            ? { web: { kind: "page" as const, url: readBoundedString(call.result.web.url, `${field}[${index}].result.web.url`, 2_000), markdown: readBoundedString(call.result.web.markdown, `${field}[${index}].result.web.markdown`, 24_000) } }
            : {}),
        ...(isRecord(call.result.utility) && call.result.utility.kind === "time"
          ? { utility: { kind: "time" as const, currentTime: readBoundedString(call.result.utility.currentTime, `${field}[${index}].result.utility.currentTime`, 64), timeZone: readBoundedString(call.result.utility.timeZone, `${field}[${index}].result.utility.timeZone`, 100) } }
          : isRecord(call.result.utility) && call.result.utility.kind === "date"
            ? { utility: { kind: "date" as const, currentDate: readBoundedString(call.result.utility.currentDate, `${field}[${index}].result.utility.currentDate`, 32), timeZone: readBoundedString(call.result.utility.timeZone, `${field}[${index}].result.utility.timeZone`, 100) } }
            : isRecord(call.result.utility) && call.result.utility.kind === "location" && call.result.utility.available === true
              ? { utility: { kind: "location" as const, available: true as const, location: readBoundedString(call.result.utility.location, `${field}[${index}].result.utility.location`, 300), source: readLocationSource(call.result.utility.source, `${field}[${index}].result.utility.source`) } }
              : isRecord(call.result.utility) && call.result.utility.kind === "location" && call.result.utility.available === false
                ? { utility: { kind: "location" as const, available: false as const, message: readBoundedString(call.result.utility.message, `${field}[${index}].result.utility.message`, 300) } }
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

  readNonEmptyString(value.systemPrompt, "systemPrompt");
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
  const readJobKey = (input: unknown, field: string) => {
    if (input === undefined) return undefined;
    if (typeof input !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(input)) {
      throw new ChatRequestValidationError(`${field} is invalid.`);
    }
    return input;
  };
  const jobId = readJobKey(value.jobId, "jobId");
  const idempotencyKey = readJobKey(value.idempotencyKey, "idempotencyKey");
  let persistence: ChatSubmissionMetadata | undefined;
  if (value.persistence !== undefined) {
    if (!isRecord(value.persistence)) throw new ChatRequestValidationError("persistence is invalid.");
    const persistenceValue = value.persistence;
    const readPersistenceId = (field: keyof ChatSubmissionMetadata) => {
      const candidate = persistenceValue[field];
      if (typeof candidate !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(candidate)) {
        throw new ChatRequestValidationError(`persistence.${field} is invalid.`);
      }
      return candidate;
    };
    const readPosition = (field: "turnIndex" | "versionIndex") => {
      const candidate = persistenceValue[field];
      if (typeof candidate !== "number" || !Number.isInteger(candidate) || candidate < 0 || candidate > 1000) {
        throw new ChatRequestValidationError(`persistence.${field} is invalid.`);
      }
      return candidate;
    };
    persistence = {
      turnId: readPersistenceId("turnId"),
      versionId: readPersistenceId("versionId"),
      userMessageId: readPersistenceId("userMessageId"),
      assistantMessageId: readPersistenceId("assistantMessageId"),
      turnIndex: readPosition("turnIndex"),
      versionIndex: readPosition("versionIndex"),
    };
  }

  return {
    systemPrompt: DEFAULT_CHAT_SYSTEM_PROMPT,
    userPresence,
    messages,
    model: value.model as ChatModelId,
    thinking: value.thinking,
    reasoningEffort: value.reasoningEffort,
    conversationId,
    jobId,
    idempotencyKey,
    persistence,
  };
}
