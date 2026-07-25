import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
} from "react";
import type {
  ChatMessageInput,
  ChatModelId,
  ChatReasoningEffort,
  ChatRequest,
  SequencedChatStreamEvent,
} from "../../lib/chat-protocol";
import {
  cancelChatJob,
  streamChatResponse,
} from "./chat-service";
import { toChatMessageInput } from "./chat-message-input";
import { generateChatTitle } from "./chat-title-service";
import { finishRunningActivities } from "./finish-running-activities";
import {
  type ConversationAction,
  type ConversationState,
} from "./conversation-reducer";
import { makeId } from "./conversation-defaults";
import type { ChatSettings, Conversation, Message } from "./conversation-types";
import {
  createChatStreamState,
  reduceChatStreamEvents,
} from "./chat-stream-reducer";

export type ActiveChatRequest = {
  conversationId: string;
  messageId: string;
  jobId: string;
  controller: AbortController;
};

export type ThinkingTiming = {
  startedAt: number;
  now: number;
};

export type ChatGenerationOptions = {
  state: ConversationState;
  settings: ChatSettings;
  model: ChatModelId;
  thinking: boolean;
  reasoningEffort: ChatReasoningEffort;
  getAccessToken: () => Promise<string | null>;
  dispatch: Dispatch<ConversationAction>;
  /** Clear the composer after a prompt is accepted. */
  onDraftConsumed?: () => void;
  /** Clear edit mode after a prompt is accepted. */
  onEditingConsumed?: () => void;
};

export type SendMessage = (
  content: string,
  editingTurnId?: string | null,
) => Promise<void>;

export type ChatGenerationResult = {
  sendMessage: SendMessage;
  stopStreaming: (conversationId?: string) => Promise<void>;
  activeRequestsRef: MutableRefObject<Record<string, ActiveChatRequest>>;
  streamingByConversation: Record<string, string>;
  waitingByMessage: Record<string, boolean>;
  thinkingByMessage: Record<string, ThinkingTiming>;
  isStreaming: boolean;
};

type GenerationInput = {
  state: ConversationState;
  settings: ChatSettings;
  model: ChatModelId;
  thinking: boolean;
  reasoningEffort: ChatReasoningEffort;
  getAccessToken: () => Promise<string | null>;
  dispatch: Dispatch<ConversationAction>;
  onDraftConsumed?: () => void;
  onEditingConsumed?: () => void;
};

function activeConversation(state: ConversationState): Conversation | undefined {
  return state.conversations.find(({ id }) => id === state.activeId);
}

function messageById(state: ConversationState, conversationId: string, messageId: string): Message | undefined {
  const conversation = state.conversations.find(({ id }) => id === conversationId);
  return conversation?.turns
    .flatMap((turn) => turn.versions)
    .map((version) => version.assistant)
    .find(({ id }) => id === messageId);
}

/** Build the durable request context used by both normal and edited prompts. */
export function buildChatGenerationRequest(input: {
  conversation: Conversation;
  content: string;
  editingTurnIndex: number;
  turnId: string;
  versionId: string;
  userMessageId: string;
  assistantMessageId: string;
  jobId: string;
  settings: ChatSettings;
  model: ChatModelId;
  thinking: boolean;
  reasoningEffort: ChatReasoningEffort;
}): ChatRequest {
  const contextTurns = input.editingTurnIndex >= 0
    ? input.conversation.turns.slice(0, input.editingTurnIndex)
    : input.conversation.turns;
  const userMessage: Message = {
    id: input.userMessageId,
    role: "user",
    content: input.content,
  };
  const requestMessages = contextTurns
    .flatMap((turn) => {
      const version = turn.versions[turn.activeVersion];
      return version ? [version.user, version.assistant] : [];
    })
    .concat(userMessage)
    .map(toChatMessageInput)
    .filter((message): message is ChatMessageInput => message !== null);
  const versionIndex = input.editingTurnIndex >= 0
    ? input.conversation.turns[input.editingTurnIndex]?.versions.length ?? 0
    : 0;
  return {
    messages: requestMessages,
    systemPrompt: input.settings.systemPrompt,
    userPresence: input.settings.userPresence,
    model: input.model,
    thinking: input.thinking,
    reasoningEffort: input.reasoningEffort,
    conversationId: input.conversation.id,
    jobId: input.jobId,
    idempotencyKey: input.jobId,
    persistence: {
      turnId: input.turnId,
      versionId: input.versionId,
      userMessageId: input.userMessageId,
      assistantMessageId: input.assistantMessageId,
      turnIndex: input.editingTurnIndex >= 0 ? input.editingTurnIndex : input.conversation.turns.length,
      versionIndex,
    },
  };
}

/**
 * Own durable stream delivery and transient generation state without rendering
 * UI. Conversation changes are emitted as serializable reducer actions.
 */
export function useChatGeneration(options: ChatGenerationOptions): ChatGenerationResult {
  const optionsRef = useRef<GenerationInput>(options);
  const stateRef = useRef(options.state);
  const activeRequestsRef = useRef<Record<string, ActiveChatRequest>>({});
  const [streamingByConversation, setStreamingByConversation] = useState<Record<string, string>>({});
  const [waitingByMessage, setWaitingByMessage] = useState<Record<string, boolean>>({});
  const [thinkingByMessage, setThinkingByMessage] = useState<Record<string, ThinkingTiming>>({});

  useEffect(() => {
    optionsRef.current = options;
    stateRef.current = options.state;
  }, [options]);

  useEffect(() => {
    if (!Object.keys(thinkingByMessage).length) return undefined;
    const timer = setInterval(() => {
      const now = performance.now();
      setThinkingByMessage((current) => Object.fromEntries(
        Object.entries(current).map(([id, timing]) => [id, { ...timing, now }]),
      ));
    }, 100);
    return () => clearInterval(timer);
  }, [thinkingByMessage]);

  const clearRequestState = useCallback((conversationId: string, messageId: string) => {
    delete activeRequestsRef.current[conversationId];
    setStreamingByConversation((current) => {
      if (current[conversationId] !== messageId) return current;
      const next = { ...current };
      delete next[conversationId];
      return next;
    });
    setWaitingByMessage((current) => {
      if (!(messageId in current)) return current;
      const next = { ...current };
      delete next[messageId];
      return next;
    });
    setThinkingByMessage((current) => {
      if (!(messageId in current)) return current;
      const next = { ...current };
      delete next[messageId];
      return next;
    });
  }, []);

  const sendMessage = useCallback<SendMessage>(async (rawContent, editingTurnId = null) => {
    const input = optionsRef.current;
    const content = rawContent.trim();
    const conversation = activeConversation(input.state);
    if (!content || !conversation || activeRequestsRef.current[conversation.id]) return;

    const editingTurnIndex = editingTurnId
      ? conversation.turns.findIndex((turn) => turn.id === editingTurnId)
      : -1;
    const turnId = editingTurnIndex >= 0 ? conversation.turns[editingTurnIndex].id : makeId();
    const versionId = makeId();
    const userMessage: Message = { id: makeId(), role: "user", content };
    const jobId = makeId();
    const assistantMessage: Message = {
      id: makeId(),
      role: "assistant",
      content: "",
      reasoning: "",
      activities: [],
      artifacts: [],
      thinkingEnabled: input.thinking,
      status: "streaming",
      jobId,
      lastSequence: 0,
    };

    if (editingTurnIndex >= 0) {
      input.dispatch({
        type: "APPEND_TURN_VERSION",
        conversationId: conversation.id,
        turnId,
        version: { id: versionId, user: userMessage, assistant: assistantMessage },
      });
    } else {
      input.dispatch({
        type: "APPEND_TURN",
        conversationId: conversation.id,
        turn: {
          id: turnId,
          versions: [{ id: versionId, user: userMessage, assistant: assistantMessage }],
          activeVersion: 0,
        },
      });
    }
    input.onDraftConsumed?.();
    input.onEditingConsumed?.();

    const controller = new AbortController();
    activeRequestsRef.current[conversation.id] = {
      conversationId: conversation.id,
      messageId: assistantMessage.id,
      jobId,
      controller,
    };
    setStreamingByConversation((current) => ({ ...current, [conversation.id]: assistantMessage.id }));
    setWaitingByMessage((current) => ({ ...current, [assistantMessage.id]: true }));
    const thinkingStartedAt = input.thinking ? performance.now() : null;
    if (thinkingStartedAt !== null) {
      setThinkingByMessage((current) => ({
        ...current,
        [assistantMessage.id]: { startedAt: thinkingStartedAt, now: thinkingStartedAt },
      }));
    }

    let streamState = createChatStreamState(assistantMessage);
    const pendingEvents: SequencedChatStreamEvent[] = [];
    let streamFrame: number | null = null;
    const flushPendingEvents = () => {
      streamFrame = null;
      const events = pendingEvents.splice(0);
      if (!events.length) return;
      streamState = reduceChatStreamEvents(streamState, events, { thinkingStartedAt });
      inputRefDispatch(input, {
        type: "UPDATE_MESSAGE",
        conversationId: conversation.id,
        messageId: assistantMessage.id,
        patch: streamState.message,
      });
      if (!streamState.waiting) {
        setWaitingByMessage((current) => {
          if (!(assistantMessage.id in current)) return current;
          const next = { ...current };
          delete next[assistantMessage.id];
          return next;
        });
      }
      if (streamState.thinkingFinished) {
        setThinkingByMessage((current) => {
          if (!(assistantMessage.id in current)) return current;
          const next = { ...current };
          delete next[assistantMessage.id];
          return next;
        });
      }
    };
    const flushPendingEventsNow = () => {
      if (streamFrame !== null) cancelAnimationFrame(streamFrame);
      flushPendingEvents();
    };
    try {
      const accessToken = await input.getAccessToken();
      if (!accessToken) throw new Error("Your session expired. Please sign in again.");
      if (conversation.turns.length === 0) {
        void generateChatTitle(content, conversation.id, accessToken)
          .then((title) => inputRefDispatch(input, { type: "UPDATE_TITLE", conversationId: conversation.id, title }))
          .catch(() => undefined);
      }
      if (
        controller.signal.aborted ||
        activeRequestsRef.current[conversation.id]?.messageId !== assistantMessage.id
      ) return;

      const request = buildChatGenerationRequest({
        conversation,
        content,
        editingTurnIndex,
        turnId,
        versionId,
        userMessageId: userMessage.id,
        assistantMessageId: assistantMessage.id,
        jobId,
        settings: input.settings,
        model: input.model,
        thinking: input.thinking,
        reasoningEffort: input.reasoningEffort,
      });
      for await (const event of streamChatResponse(request, accessToken, controller.signal)) {
        const lastPendingSequence = pendingEvents.at(-1)?.sequence
          ?? streamState.message.lastSequence
          ?? 0;
        if (event.sequence <= lastPendingSequence) continue;
        pendingEvents.push(event);
        if (streamFrame === null) streamFrame = requestAnimationFrame(flushPendingEvents);
      }
      flushPendingEventsNow();
    } catch (error: unknown) {
      if (controller.signal.aborted) {
        if (streamFrame !== null) cancelAnimationFrame(streamFrame);
        streamFrame = null;
        pendingEvents.length = 0;
      } else {
        flushPendingEventsNow();
        const message = error instanceof Error ? error.message : "The response failed.";
        inputRefDispatch(input, {
          type: "MARK_MESSAGE_ERROR",
          conversationId: conversation.id,
          messageId: assistantMessage.id,
          error: message,
        });
      }
    } finally {
      const isCurrentRequest = activeRequestsRef.current[conversation.id]?.messageId === assistantMessage.id;
      if (isCurrentRequest && thinkingStartedAt !== null && !streamState.thinkingFinished) {
        inputRefDispatch(input, {
          type: "UPDATE_MESSAGE",
          conversationId: conversation.id,
          messageId: assistantMessage.id,
          patch: { thinkingDurationMs: Math.max(0, performance.now() - thinkingStartedAt) },
        });
      }
      if (isCurrentRequest) clearRequestState(conversation.id, assistantMessage.id);
    }
  }, [clearRequestState]);

  const stopStreaming = useCallback(async (conversationId = optionsRef.current.state.activeId) => {
    const request = activeRequestsRef.current[conversationId];
    if (!request) return;
    const input = optionsRef.current;
    const message = messageById(stateRef.current, conversationId, request.messageId);
    const stoppedAt = Date.now();
    const timing = thinkingByMessage[request.messageId];
    request.controller.abort();
    input.dispatch({
      type: "UPDATE_MESSAGE",
      conversationId,
      messageId: request.messageId,
      patch: {
        ...(message ? { activities: finishRunningActivities(message.activities, true, stoppedAt) } : {}),
        ...(timing && message?.thinkingDurationMs === undefined
          ? { thinkingDurationMs: Math.max(0, performance.now() - timing.startedAt) }
          : {}),
      },
    });
    input.dispatch({ type: "MARK_MESSAGE_CANCELLED", conversationId, messageId: request.messageId });
    clearRequestState(conversationId, request.messageId);
    const token = await input.getAccessToken();
    if (token) await cancelChatJob(conversationId, request.jobId, token).catch(() => undefined);
  }, [clearRequestState, thinkingByMessage]);

  return {
    sendMessage,
    stopStreaming,
    activeRequestsRef,
    streamingByConversation,
    waitingByMessage,
    thinkingByMessage,
    isStreaming: Object.keys(streamingByConversation).length > 0,
  };
}

function inputRefDispatch(input: GenerationInput, action: ConversationAction): void {
  // Keeping this tiny indirection makes async callbacks explicit about the
  // reducer dispatch they captured while avoiding arbitrary setter callbacks in
  // actions themselves.
  input.dispatch(action);
}
