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
  ChatModelRef,
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
import { getActiveConversationTurns } from "../../lib/chat-history";
import { makeId } from "./conversation-defaults";
import type { ChatSettings, Conversation, Message } from "./conversation-types";
import {
  createChatStreamState,
  reduceChatStreamEvents,
} from "./chat-stream-reducer";
import {
  type ChatImageUploadContext,
  type PendingChatImage,
  type UploadedChatImage,
  uploadChatImages,
} from "./chat-image-attachments";
import {
  deleteChatDocument,
  type ChatDocumentUploadContext,
  uploadChatDocument,
  type PendingChatDocument,
} from "./chat-document-attachments";
import type { ChatDocumentAttachment } from "../../lib/chat-document";

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
  model: ChatModelRef;
  thinking: boolean;
  reasoningEffort: ChatReasoningEffort;
  getAccessToken: () => Promise<string | null>;
  dispatch: Dispatch<ConversationAction>;
  /** Clear the composer after a prompt is accepted. */
  onDraftConsumed?: () => void;
  /** Clear edit mode after a prompt is accepted. */
  onEditingConsumed?: () => void;
  /** Clear local attachment previews after upload and analysis are accepted. */
  onAttachmentsConsumed?: () => void;
};

export type SendMessage = (
  content: string,
  editingTurnId?: string | null,
  attachments?: readonly PendingChatImage[],
  preservedAttachments?: readonly UploadedChatImage[],
  documents?: readonly PendingChatDocument[],
  preservedDocuments?: readonly ChatDocumentAttachment[],
) => Promise<void>;

export type ChatGenerationResult = {
  sendMessage: SendMessage;
  stopStreaming: (conversationId?: string) => Promise<void>;
  activeRequestsRef: MutableRefObject<Record<string, ActiveChatRequest>>;
  streamingByConversation: Record<string, string>;
  waitingByMessage: Record<string, boolean>;
  thinkingByMessage: Record<string, ThinkingTiming>;
  isStreaming: boolean;
  isSubmittingAttachments: boolean;
  isPreparingAttachments: boolean;
  submissionError: string | null;
  prepareChatImageUploads: (images: readonly PendingChatImage[]) => PendingChatImage[];
  prepareChatDocumentUpload: (document: PendingChatDocument) => PendingChatDocument;
  cancelChatDocumentPreparation: (document: PendingChatDocument) => Promise<void>;
};

type GenerationInput = {
  state: ConversationState;
  settings: ChatSettings;
  model: ChatModelRef;
  thinking: boolean;
  reasoningEffort: ChatReasoningEffort;
  getAccessToken: () => Promise<string | null>;
  dispatch: Dispatch<ConversationAction>;
  onDraftConsumed?: () => void;
  onEditingConsumed?: () => void;
  onAttachmentsConsumed?: () => void;
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

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
    || error instanceof Error && error.name === "AbortError";
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
  model: ChatModelRef;
  thinking: boolean;
  reasoningEffort: ChatReasoningEffort;
  attachments?: UploadedChatImage[];
  documents?: ChatDocumentAttachment[];
}): ChatRequest {
  const activeTurns = getActiveConversationTurns(input.conversation);
  const targetTurnIndex = input.editingTurnIndex >= 0
    ? input.editingTurnIndex
    : activeTurns.length;
  const contextTurns = activeTurns.slice(0, targetTurnIndex);
  const userMessage = {
    id: input.userMessageId,
    role: "user",
    content: input.content,
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    ...(input.documents?.length ? { documents: input.documents } : {}),
  } as Message;
  const requestMessages = contextTurns
    .flatMap((turn) => {
      const version = turn.versions[turn.activeVersion];
      return version ? [version.user, version.assistant] : [];
    })
    .concat(userMessage)
    .map(toChatMessageInput)
    .filter((message): message is ChatMessageInput => message !== null);
  const versionIndex = input.conversation.turns[targetTurnIndex]?.versions.length ?? 0;
  return {
    messages: requestMessages,
    systemPrompt: input.settings.systemPrompt,
    userPresence: input.settings.userPresence,
    model: input.model,
    thinking: input.thinking,
    reasoningEffort: input.reasoningEffort,
    contextMode: input.settings.focusedContextEnabled ? "focused" : "full",
    conversationId: input.conversation.id,
    jobId: input.jobId,
    idempotencyKey: input.jobId,
    persistence: {
      turnId: input.turnId,
      versionId: input.versionId,
      userMessageId: input.userMessageId,
      assistantMessageId: input.assistantMessageId,
      turnIndex: targetTurnIndex,
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
  const attachmentSubmissionRef = useRef(false);
  const imageDraftRef = useRef<{ conversationId: string; context: ChatImageUploadContext } | null>(null);
  const documentDraftRef = useRef<{ conversationId: string; context: ChatDocumentUploadContext } | null>(null);
  const [streamingByConversation, setStreamingByConversation] = useState<Record<string, string>>({});
  const [waitingByMessage, setWaitingByMessage] = useState<Record<string, boolean>>({});
  const [thinkingByMessage, setThinkingByMessage] = useState<Record<string, ThinkingTiming>>({});
  const [isSubmittingAttachments, setIsSubmittingAttachments] = useState(false);
  const [preparingImageCount, setPreparingImageCount] = useState(0);
  const [, setPreparingDocumentCount] = useState(0);
  const [, setDocumentPreparationRevision] = useState(0);
  const [submissionError, setSubmissionError] = useState<string | null>(null);

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

  const sendMessage = useCallback<SendMessage>(async (
    rawContent,
    editingTurnId = null,
    pendingImages = [],
    preservedAttachments = [],
    pendingDocuments = [],
    preservedDocuments = [],
  ) => {
    const input = optionsRef.current;
    const authoredContent = rawContent.trim();
    const content = authoredContent || (pendingImages.length || preservedAttachments.length || pendingDocuments.length || preservedDocuments.length ? "Attachment added" : "");
    const conversation = activeConversation(input.state);
    if (
      !content ||
      !conversation ||
      activeRequestsRef.current[conversation.id] ||
      attachmentSubmissionRef.current
    ) return;

    const editingTurnIndex = editingTurnId
      ? conversation.turns.findIndex((turn) => turn.id === editingTurnId)
      : -1;
    const activeTurns = getActiveConversationTurns(conversation);
    const targetTurnIndex = editingTurnIndex >= 0 ? editingTurnIndex : activeTurns.length;
    const existingTargetTurn = conversation.turns[targetTurnIndex];
    const turnId = existingTargetTurn?.id ?? makeId();
    const versionId = makeId();
    const parentVersionId = activeTurns[targetTurnIndex - 1]
      ?.versions[activeTurns[targetTurnIndex - 1].activeVersion]?.id ?? null;
    const imageContext = pendingImages[0]?.uploadContext?.conversationId === conversation.id
      ? pendingImages[0].uploadContext
      : undefined;
    const documentContext = pendingDocuments[0]?.uploadContext?.conversationId === conversation.id
      ? pendingDocuments[0].uploadContext
      : undefined;
    if (pendingDocuments.some((document) => document.uploadContext && document.uploadContext.conversationId !== conversation.id)) {
      setSubmissionError("This document is no longer attached to the active conversation.");
      return;
    }
    const userMessageId = imageContext?.userMessageId ?? documentContext?.userMessageId ?? makeId();
    const jobId = makeId();
    const effectiveJobId = imageContext?.jobId ?? documentContext?.jobId ?? jobId;
    let uploadedImages: UploadedChatImage[] = [...preservedAttachments];
    let uploadedDocuments: ChatDocumentAttachment[] = [...preservedDocuments];
    setSubmissionError(null);
    if (pendingImages.length) {
      attachmentSubmissionRef.current = true;
      setIsSubmittingAttachments(true);
      try {
        const accessToken = await input.getAccessToken();
        if (!accessToken) throw new Error("Your session expired. Please sign in again.");
        const prepared = imageContext ? pendingImages.map((image) => image.uploadPromise) : [];
        if (prepared.every((promise): promise is Promise<UploadedChatImage> => Boolean(promise))) {
          uploadedImages = [...preservedAttachments, ...(await Promise.all(prepared))];
        } else {
          uploadedImages = [...preservedAttachments, ...(await uploadChatImages({
            conversationId: conversation.id,
            userMessageId,
            jobId: effectiveJobId,
            images: pendingImages,
            accessToken,
            signal: new AbortController().signal,
          }))];
        }
      } catch (error) {
        setSubmissionError(error instanceof Error ? error.message : "The images could not be uploaded.");
        return;
      } finally {
        attachmentSubmissionRef.current = false;
        setIsSubmittingAttachments(false);
      }
    }
    if (pendingDocuments.length) {
      attachmentSubmissionRef.current = true;
      setIsSubmittingAttachments(true);
      try {
        const accessToken = await input.getAccessToken();
        if (!accessToken) throw new Error("Your session expired. Please sign in again.");
        const prepared = pendingDocuments.map((document) => document.preparationPromise ?? uploadChatDocument({
          conversationId: conversation.id,
          userMessageId,
          jobId: effectiveJobId,
          document,
          accessToken,
          signal: document.abortController?.signal ?? new AbortController().signal,
        }));
        uploadedDocuments = await Promise.all(prepared);
      } catch (error) {
        if (pendingDocuments.some((document) => document.abortController?.signal.aborted)) return;
        setSubmissionError(error instanceof Error ? error.message : "The document could not be prepared.");
        return;
      } finally {
        attachmentSubmissionRef.current = false;
        setIsSubmittingAttachments(false);
      }
    }
    const userMessage = {
      id: userMessageId,
      role: "user",
      content,
      ...(uploadedImages.length ? { attachments: uploadedImages } : {}),
      ...(uploadedDocuments.length ? { documents: uploadedDocuments } : {}),
    } as Message;
    const assistantMessage: Message = {
      id: makeId(),
      role: "assistant",
      content: "",
      reasoning: "",
      activities: [],
      artifacts: [],
      thinkingEnabled: input.thinking,
      status: "streaming",
      jobId: effectiveJobId,
      lastSequence: 0,
    };

    if (existingTargetTurn) {
      input.dispatch({
        type: "APPEND_TURN_VERSION",
        conversationId: conversation.id,
        turnId,
        version: {
          id: versionId,
          user: userMessage,
          assistant: assistantMessage,
          parentVersionId,
        },
      });
    } else {
      input.dispatch({
        type: "APPEND_TURN",
        conversationId: conversation.id,
        turn: {
          id: turnId,
          versions: [{
            id: versionId,
            user: userMessage,
            assistant: assistantMessage,
            parentVersionId,
          }],
          activeVersion: 0,
        },
      });
    }
    const controller = new AbortController();
    activeRequestsRef.current[conversation.id] = {
      conversationId: conversation.id,
      messageId: assistantMessage.id,
      jobId: effectiveJobId,
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
      const shouldGenerateTitle = activeTurns.length === 0;
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
        jobId: effectiveJobId,
        settings: input.settings,
        model: input.model,
        thinking: input.thinking,
        reasoningEffort: input.reasoningEffort,
        attachments: uploadedImages,
        documents: uploadedDocuments,
      });
      let submissionAccepted = false;
      for await (const event of streamChatResponse(request, accessToken, controller.signal)) {
        if (!submissionAccepted) {
          submissionAccepted = true;
          pendingDocuments.forEach((document) => { document.consumed = true; });
          if (stateRef.current.activeId === conversation.id) {
            input.onDraftConsumed?.();
            input.onEditingConsumed?.();
            input.onAttachmentsConsumed?.();
          }
          imageDraftRef.current = null;
          documentDraftRef.current = null;
        }
        const lastPendingSequence = pendingEvents.at(-1)?.sequence
          ?? streamState.message.lastSequence
          ?? 0;
        if (event.sequence <= lastPendingSequence) continue;
        pendingEvents.push(event);
        if (streamFrame === null) streamFrame = requestAnimationFrame(flushPendingEvents);
      }
      flushPendingEventsNow();
      if (shouldGenerateTitle && !controller.signal.aborted) {
        void generateChatTitle(content, conversation.id, accessToken)
          .then((title) => inputRefDispatch(input, { type: "UPDATE_TITLE", conversationId: conversation.id, title }))
          .catch(() => undefined);
      }
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

  const prepareChatImageUploads = useCallback((images: readonly PendingChatImage[]): PendingChatImage[] => {
    const input = optionsRef.current;
    const conversation = activeConversation(input.state);
    if (!conversation || !images.length) return [...images];
    const existing = imageDraftRef.current;
    const documentDraft = documentDraftRef.current;
    const context = existing?.conversationId === conversation.id
      ? existing.context
      : documentDraft?.conversationId === conversation.id
        ? documentDraft.context
        : { conversationId: conversation.id, userMessageId: makeId(), jobId: makeId() };
    imageDraftRef.current = { conversationId: conversation.id, context };
    documentDraftRef.current = { conversationId: conversation.id, context };
    const accessTokenPromise = input.getAccessToken();
    setPreparingImageCount((count) => count + images.length);
    const uploadPromise = uploadChatImages({
      conversationId: conversation.id,
      userMessageId: context.userMessageId,
      jobId: context.jobId,
      images,
      accessToken: accessTokenPromise.then((token) => token ?? ""),
      signal: new AbortController().signal,
    }).finally(() => {
      setPreparingImageCount((count) => Math.max(0, count - images.length));
    });
    const trackedUploadPromise = uploadPromise.catch((error: unknown) => {
      setSubmissionError(error instanceof Error ? error.message : "The images could not be prepared for chat.");
      throw error;
    });
    void trackedUploadPromise.catch(() => undefined);
    return images.map((image, index) => ({
      ...image,
      uploadContext: context,
      uploadPromise: trackedUploadPromise.then((uploaded) => uploaded[index]),
    }));
  }, []);

  const prepareChatDocumentUpload = useCallback((document: PendingChatDocument): PendingChatDocument => {
    const input = optionsRef.current;
    const conversation = activeConversation(input.state);
    if (!conversation) return document;
    if (document.preparationPromise && document.uploadContext?.conversationId === conversation.id) return document;

    const existingImage = imageDraftRef.current;
    const existingDocument = documentDraftRef.current;
    const context = existingImage?.conversationId === conversation.id
      ? existingImage.context
      : existingDocument?.conversationId === conversation.id
        ? existingDocument.context
        : { conversationId: conversation.id, userMessageId: makeId(), jobId: makeId() };
    imageDraftRef.current = { conversationId: conversation.id, context };
    documentDraftRef.current = { conversationId: conversation.id, context };

    const abortController = new AbortController();
    const prepared: PendingChatDocument = {
      ...document,
      uploadContext: context,
      abortController,
      preparationStatus: "uploading",
      preparationError: undefined,
      consumed: false,
    };
    const updatePreparation = (patch: Partial<Pick<PendingChatDocument, "preparationStatus" | "preparationError">>) => {
      Object.assign(prepared, patch);
      setDocumentPreparationRevision((revision) => revision + 1);
    };
    const setStage = (stage: "uploading" | "parsing") => updatePreparation({ preparationStatus: stage });

    setPreparingDocumentCount((count) => count + 1);
    const preparation = input.getAccessToken()
      .then((accessToken) => {
        if (!accessToken) throw new Error("Your session expired. Please sign in again.");
        return uploadChatDocument({
          conversationId: conversation.id,
          userMessageId: context.userMessageId,
          jobId: context.jobId,
          document: prepared,
          accessToken,
          signal: abortController.signal,
          onStageChange: setStage,
        });
      })
      .then((uploaded) => {
        if (!abortController.signal.aborted) updatePreparation({ preparationStatus: "ready", preparationError: undefined });
        return uploaded;
      })
      .catch((error: unknown) => {
        if (abortController.signal.aborted || isAbortError(error)) {
          updatePreparation({ preparationStatus: "cancelled", preparationError: undefined });
        } else {
          updatePreparation({
            preparationStatus: "error",
            preparationError: error instanceof Error ? error.message : "The document could not be prepared.",
          });
        }
        throw error;
      });
    const trackedPreparation = preparation.finally(() => {
      setPreparingDocumentCount((count) => Math.max(0, count - 1));
    });
    prepared.preparationPromise = trackedPreparation;
    void trackedPreparation.catch(() => undefined);
    return prepared;
  }, []);

  const cancelChatDocumentPreparation = useCallback(async (document: PendingChatDocument): Promise<void> => {
    if (document.consumed) return;
    const previousPreparationError = document.preparationError;
    document.abortController?.abort();
    document.preparationStatus = "cancelled";
    document.preparationError = undefined;
    if (previousPreparationError) {
      setSubmissionError((current) => current === previousPreparationError ? null : current);
    }
    setDocumentPreparationRevision((revision) => revision + 1);
    if (document.cleanupPromise) return document.cleanupPromise;

    const cleanup = (async () => {
      const context = document.uploadContext;
      if (!context) return;
      const accessToken = await optionsRef.current.getAccessToken();
      if (!accessToken) return;
      await deleteChatDocument({
        conversationId: context.conversationId,
        document,
        accessToken,
      });
    })();
    document.cleanupPromise = cleanup.catch(() => {
      document.cleanupPromise = undefined;
    });
    await document.cleanupPromise;
  }, []);

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
    isSubmittingAttachments,
    isPreparingAttachments: preparingImageCount > 0,
    submissionError,
    prepareChatImageUploads,
    prepareChatDocumentUpload,
    cancelChatDocumentPreparation,
  };
}

function inputRefDispatch(input: GenerationInput, action: ConversationAction): void {
  // Keeping this tiny indirection makes async callbacks explicit about the
  // reducer dispatch they captured while avoiding arbitrary setter callbacks in
  // actions themselves.
  input.dispatch(action);
}
