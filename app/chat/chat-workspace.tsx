"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { useParams, useRouter } from "next/navigation";
import type { AuthUser } from "../auth/types";
import { SettingsModal } from "../settings/settings-modal";
import { ChatSearchDialog } from "./chat-search-dialog";
import { ChatComposer } from "./chat-composer";
import type { PendingChatImage } from "./chat-image-attachments";
import type { PendingChatDocument } from "./chat-document-attachments";
import { ChatSidebar } from "./chat-sidebar";
import { ChatTranscript } from "./chat-transcript";
import { isTranscriptNearBottom } from "./transcript-scroll";
import { fetchChatUsage } from "./chat-usage-service";
import { createConversation, DEFAULT_CHAT_SETTINGS } from "./conversation-defaults";
import {
  resolveConversationRoute,
} from "./conversation-routing";
import { DeleteConfirmationDialog } from "./delete-confirmation-dialog";
import { conversationReducer, createInitialConversationState } from "./conversation-reducer";
import {
  deleteConversation,
  loadConversation,
  saveConversationSelection,
  saveSettings,
} from "./conversation-storage";
import type { ConversationTurn, Message } from "./conversation-types";
import { useChatGeneration } from "./use-chat-generation";
import { useChatPreferences } from "./use-chat-preferences";
import { useChatShortcuts } from "./use-chat-shortcuts";
import { useMobileHistoryNavigation } from "./use-mobile-history-navigation";
import { usePersistedJobRecovery } from "./use-persisted-job-recovery";
import type { ChatArtifact, ChatImageAttachment } from "../../lib/chat-protocol";
import type { ChatDocumentAttachment } from "../../lib/chat-document";
import type { ChatConversationSummary } from "../../lib/chat-history";
import {
  fetchChatArtifact,
  fetchChatBootstrap,
  ChatRequestError,
} from "./chat-service";
import {
  modelPreferencesRecord,
} from "../../lib/chat-bootstrap";
import type { ChatModelPreference } from "../../lib/chat-model-preference";
import { defaultPdfPreviewWidth, clampPdfPreviewWidth } from "./pdf-preview-layout";
import { PdfPreviewPanel, type PdfPreviewLoadState } from "./pdf-preview-panel";

export type ChatWorkspaceProps = {
  user: AuthUser;
  getAccessToken: () => Promise<string | null>;
  onSignOut: () => Promise<void>;
  onSessionInvalid: () => Promise<void>;
};

export function ChatWorkspace({
  user,
  getAccessToken,
  onSignOut,
  onSessionInvalid,
}: ChatWorkspaceProps) {
  const router = useRouter();
  const params = useParams<{ conversationId?: string }>();
  const [state, dispatch] = useReducer(conversationReducer, undefined, createInitialConversationState);
  const [ready, setReady] = useState(false);
  const [draft, setDraft] = useState("");
  const [attachmentResetKey, setAttachmentResetKey] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settings, setSettings] = useState(DEFAULT_CHAT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [openMenu, setOpenMenu] = useState<"model" | "thinking" | null>(null);
  const [openConversationActions, setOpenConversationActions] = useState<string | null>(null);
  const [deleteConversationId, setDeleteConversationId] = useState<string | null>(null);
  const [deleteConversationError, setDeleteConversationError] = useState<string | null>(null);
  const [deletingConversationId, setDeletingConversationId] = useState<string | null>(null);
  const [editingTurnId, setEditingTurnId] = useState<string | null>(null);
  const [editingAttachments, setEditingAttachments] = useState<ChatImageAttachment[]>([]);
  const [editingDocuments, setEditingDocuments] = useState<ChatDocumentAttachment[]>([]);
  const [openMessageActions, setOpenMessageActions] = useState<string | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [recoveredStreaming, setRecoveredStreaming] = useState<Record<string, string>>({});
  const [conversationSummaries, setConversationSummaries] = useState<ChatConversationSummary[]>([]);
  const [bootstrapModelPreferences, setBootstrapModelPreferences] = useState<Record<string, ChatModelPreference>>({});
  const [bootstrapComplete, setBootstrapComplete] = useState(false);
  const [loadingConversationId, setLoadingConversationId] = useState<string | null>(null);
  const [conversationLoadError, setConversationLoadError] = useState<string | null>(null);
  const [pdfPreview, setPdfPreview] = useState<{
    artifact: ChatArtifact;
    loadState: PdfPreviewLoadState;
  } | null>(null);
  const [pdfPreviewWidth, setPdfPreviewWidth] = useState(360);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const longPressTimerRef = useRef<number | null>(null);
  const conversationLongPressTimerRef = useRef<number | null>(null);
  const pdfPreviewUrlRef = useRef<string | null>(null);
  const pdfPreviewRequestRef = useRef(0);
  const conversationLoadRequestRef = useRef(0);
  const requestedConversationId = typeof params.conversationId === "string"
    ? params.conversationId.trim() || undefined
    : undefined;
  const initialConversationIdRef = useRef(requestedConversationId);
  const handledRouteRef = useRef<string | undefined | null>(null);

  const loadUsage = useCallback(async (range: Parameters<typeof fetchChatUsage>[0]) => {
    const accessToken = await getAccessToken();
    if (!accessToken) throw new Error("Sign in to view usage.");
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return fetchChatUsage(range, timeZone, accessToken);
  }, [getAccessToken]);

  useEffect(() => {
    let mounted = true;
    const requestId = ++conversationLoadRequestRef.current;
    void (async () => {
      try {
        const token = await getAccessToken();
        if (!token) throw new ChatRequestError(401, "Your session expired.");
        const bootstrap = await fetchChatBootstrap(token, initialConversationIdRef.current);
        if (!mounted || requestId !== conversationLoadRequestRef.current) {
          return;
        }
        setConversationSummaries(bootstrap.summaries);
        setRecoveredStreaming(bootstrap.streamingByConversation);
        setSettings({
          ...DEFAULT_CHAT_SETTINGS,
          userPresence: bootstrap.userPreferences.userPresence,
        });
        setBootstrapModelPreferences(modelPreferencesRecord(bootstrap.modelPreferences));
        setBootstrapComplete(true);
        if (bootstrap.requestedConversationId === initialConversationIdRef.current) {
          handledRouteRef.current = initialConversationIdRef.current;
        }
        let initialConversation = bootstrap.activeConversation;
        // A valid unknown UUID represents a new client-only conversation.
        if (!initialConversation) {
          initialConversation = bootstrap.requestedConversationId
            ? { ...createConversation(), id: bootstrap.requestedConversationId }
            : createConversation();
        }
        if (!mounted || requestId !== conversationLoadRequestRef.current) {
          return;
        }
        dispatch({
          type: "LOAD_CONVERSATIONS",
          conversations: [initialConversation],
          activeId: initialConversation.id,
        });
        setReady(true);
      } catch (error) {
        if (!mounted || requestId !== conversationLoadRequestRef.current) return;
        if (error instanceof ChatRequestError && error.status === 401) {
          await onSessionInvalid();
          return;
        }
        setConversationLoadError(
          error instanceof Error
            ? error.message
            : "The conversation could not be loaded.",
        );
        const fallback = createConversation();
        dispatch({
          type: "LOAD_CONVERSATIONS",
          conversations: [fallback],
          activeId: fallback.id,
        });
        setBootstrapModelPreferences({});
        setBootstrapComplete(true);
        setReady(true);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [getAccessToken, onSessionInvalid]);

  const hydrateAndSelectConversation = useCallback(
    async (conversationId: string) => {
      const requestId = ++conversationLoadRequestRef.current;
      const cached = state.conversations.find(
        ({ id }) => id === conversationId,
      );
      if (cached) {
        setLoadingConversationId(null);
        setConversationLoadError(null);
        dispatch({
          type: "SELECT_CONVERSATION",
          conversationId,
        });
        return;
      }
      setLoadingConversationId(conversationId);
      setConversationLoadError(null);
      try {
        const token = await getAccessToken();
        if (!token) throw new Error("Your session expired.");
        const conversation = await loadConversation(
          conversationId,
          token,
        );
        if (!conversation) {
          throw new Error("Conversation not found.");
        }
        if (requestId !== conversationLoadRequestRef.current) return;
        dispatch({
          type: "HYDRATE_CONVERSATION",
          conversation,
          select: true,
        });
      } catch (error) {
        if (requestId !== conversationLoadRequestRef.current) return;
        setConversationLoadError(
          error instanceof Error
            ? error.message
            : "The conversation could not be loaded.",
        );
      } finally {
        if (requestId === conversationLoadRequestRef.current) {
          setLoadingConversationId(null);
        }
      }
    },
    [getAccessToken, state.conversations],
  );

  useEffect(() => {
    if (!ready || !state.activeId) return;
    if (handledRouteRef.current === requestedConversationId) return;
    handledRouteRef.current = requestedConversationId;
    const knownIds = new Set(
      conversationSummaries.map(({ id }) => id),
    );
    const resolution = resolveConversationRoute(
      state,
      requestedConversationId,
      knownIds,
    );
    if (resolution.type === "select") {
      dispatch({ type: "SELECT_CONVERSATION", conversationId: resolution.conversationId });
    } else if (resolution.type === "load") {
      // The route resolution starts an asynchronous remote hydration request.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void hydrateAndSelectConversation(resolution.conversationId);
    } else if (resolution.type === "create") {
      dispatch({ type: "CREATE_CONVERSATION", conversation: resolution.conversation });
    } else if (resolution.type === "redirect") {
      router.replace(`/chat/${resolution.conversationId}`);
    }
  }, [
    conversationSummaries,
    hydrateAndSelectConversation,
    ready,
    requestedConversationId,
    router,
    state,
  ]);

  const preferences = useChatPreferences({
    activeConversationId: state.activeId,
    getAccessToken,
    initialModelPreferences: bootstrapModelPreferences,
    bootstrapComplete,
  });
  const generation = useChatGeneration({
    state,
    settings,
    model: preferences.model,
    thinking: preferences.effectiveThinking,
    reasoningEffort: preferences.effectiveEffort,
    getAccessToken,
    dispatch,
    onDraftConsumed: () => setDraft(""),
    onEditingConsumed: () => {
      setEditingTurnId(null);
      setEditingAttachments([]);
      setEditingDocuments([]);
    },
    onAttachmentsConsumed: () => setAttachmentResetKey((current) => current + 1),
  });

  usePersistedJobRecovery({
    enabled: ready,
    conversations: state.conversations,
    getAccessToken,
    dispatch,
    scopeKey: user.id,
    onConversationStreamingChange: (conversationId, streaming) => {
      setRecoveredStreaming((current) => {
        const next = { ...current };
        if (streaming) next[conversationId] = "persisted";
        else delete next[conversationId];
        return next;
      });
    },
  });

  const active = state.conversations.find(({ id }) => id === state.activeId);
  const streamingByConversation = useMemo(
    () => ({ ...recoveredStreaming, ...generation.streamingByConversation }),
    [generation.streamingByConversation, recoveredStreaming],
  );
  const activeStreaming = Boolean(streamingByConversation[state.activeId]);
  const sidebarConversations = useMemo(() => {
    const summariesById = new Map(
      conversationSummaries.map((summary) => [summary.id, summary]),
    );
    const loadedById = new Map(
      state.conversations.map((conversation) => [
        conversation.id,
        conversation,
      ]),
    );
    const localConversations = state.conversations
      .filter(({ id }) => !summariesById.has(id))
      .map(({ id, title }) => ({ id, title }));
    const persistedConversations = conversationSummaries.map(
      (summary) => ({
        id: summary.id,
        // Use the hydrated title so generated titles update immediately.
        title: loadedById.get(summary.id)?.title ?? summary.title,
      }),
    );
    return [...localConversations, ...persistedConversations];
  }, [conversationSummaries, state.conversations]);

  const releasePdfPreviewUrl = useCallback(() => {
    if (!pdfPreviewUrlRef.current) return;
    URL.revokeObjectURL(pdfPreviewUrlRef.current);
    pdfPreviewUrlRef.current = null;
  }, []);

  const closePdfPreview = useCallback(() => {
    pdfPreviewRequestRef.current += 1;
    releasePdfPreviewUrl();
    setPdfPreview(null);
  }, [releasePdfPreviewUrl]);

  const openPdfPreview = useCallback((artifact: ChatArtifact) => {
    const requestId = pdfPreviewRequestRef.current + 1;
    pdfPreviewRequestRef.current = requestId;
    releasePdfPreviewUrl();
    setPdfPreviewWidth(defaultPdfPreviewWidth(window.innerWidth));
    setPdfPreview({ artifact, loadState: { status: "loading" } });

    void (async () => {
      try {
        const accessToken = await getAccessToken();
        if (!accessToken) throw new Error("Your session expired. Sign in and try again.");
        const blob = await fetchChatArtifact(artifact, accessToken);
        const url = URL.createObjectURL(blob);
        if (pdfPreviewRequestRef.current !== requestId) {
          URL.revokeObjectURL(url);
          return;
        }
        pdfPreviewUrlRef.current = url;
        setPdfPreview({ artifact, loadState: { status: "loaded", blob, url } });
      } catch {
        if (pdfPreviewRequestRef.current !== requestId) return;
        setPdfPreview({
          artifact,
          loadState: {
            status: "error",
            message: "The PDF could not be loaded.",
          },
        });
      }
    })();
  }, [getAccessToken, releasePdfPreviewUrl]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(closePdfPreview);
    return () => window.cancelAnimationFrame(frame);
  }, [closePdfPreview, state.activeId]);

  useEffect(() => {
    const handleResize = () => {
      setPdfPreviewWidth((width) => clampPdfPreviewWidth(width, window.innerWidth));
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => () => {
    pdfPreviewRequestRef.current += 1;
    releasePdfPreviewUrl();
  }, [releasePdfPreviewUrl]);

  const startNewChat = useCallback(() => {
    shouldAutoScrollRef.current = true;
    conversationLoadRequestRef.current += 1;
    setLoadingConversationId(null);
    setConversationLoadError(null);
    const blank = state.conversations.find(({ turns }) => turns.length === 0);
    const conversation = blank ?? createConversation();
    if (blank) dispatch({ type: "SELECT_CONVERSATION", conversationId: blank.id });
    else dispatch({ type: "CREATE_CONVERSATION", conversation });
    router.push(`/chat/${conversation.id}`);
    setDraft("");
    setEditingTurnId(null);
    setEditingAttachments([]);
    setEditingDocuments([]);
    setOpenMessageActions(null);
    setOpenConversationActions(null);
    setSidebarOpen(false);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [router, state.conversations]);

  useChatShortcuts(startNewChat);
  const navigation = useMobileHistoryNavigation({
    sidebarOpen,
    settingsOpen,
    onSidebarOpen: () => setSidebarOpen(true),
    onSidebarClose: () => setSidebarOpen(false),
    onBeforeSidebarOpen: () => {
      setOpenMenu(null);
      setOpenMessageActions(null);
      setOpenConversationActions(null);
    },
  });

  useEffect(() => {
    const closeMenus = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest(".composer-menu")) setOpenMenu(null);
      if (openMessageActions && (!(event.target instanceof Element) || !event.target.closest(".message-action-popover"))) {
        setOpenMessageActions(null);
      }
      if (openConversationActions && (!(event.target instanceof Element) || !event.target.closest(".conversation-row"))) {
        setOpenConversationActions(null);
      }
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpenMenu(null);
        setOpenMessageActions(null);
        setOpenConversationActions(null);
      }
    };
    document.addEventListener("pointerdown", closeMenus);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeMenus);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openConversationActions, openMessageActions]);

  useEffect(() => () => {
    if (conversationLongPressTimerRef.current !== null) {
      window.clearTimeout(conversationLongPressTimerRef.current);
    }
  }, []);

  const latestTurn = active?.turns.at(-1);
  const latestMessage = latestTurn?.versions[latestTurn.activeVersion]?.assistant;
  const latestActivity = latestMessage?.activities?.at(-1);
  useEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript || !shouldAutoScrollRef.current) return;
    transcript.scrollTo({
      top: transcript.scrollHeight,
      behavior: "auto",
    });
  }, [
    active?.id,
    active?.turns.length,
    latestActivity?.kind,
    latestActivity?.status,
    latestMessage?.activities?.length,
    latestMessage?.artifacts?.length,
    latestMessage?.content.length,
    latestMessage?.reasoning?.length,
  ]);

  const handleTranscriptScroll = useCallback((element: HTMLDivElement) => {
    shouldAutoScrollRef.current = isTranscriptNearBottom({
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
      clientHeight: element.clientHeight,
    });
  }, []);

  const selectConversation = (conversationId: string) => {
    shouldAutoScrollRef.current = true;
    handledRouteRef.current = conversationId;
    router.push(`/chat/${conversationId}`);
    void hydrateAndSelectConversation(conversationId);
    setOpenConversationActions(null);
    setSidebarOpen(false);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };
  const editTurn = (turn: ConversationTurn) => {
    const version = turn.versions[turn.activeVersion];
    if (!version) return;
    setDraft(version.user.content);
    setEditingTurnId(turn.id);
    setEditingAttachments(version.user.attachments ?? []);
    setEditingDocuments(version.user.documents ?? []);
    setOpenMessageActions(null);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };
  const selectVersion = (turnId: string, direction: -1 | 1) => {
    const turn = active?.turns.find(({ id }) => id === turnId);
    if (!turn) return;
    const versionIndex = Math.max(0, Math.min(turn.versions.length - 1, turn.activeVersion + direction));
    const version = turn.versions[versionIndex];
    if (!version) return;
    dispatch({ type: "SELECT_TURN_VERSION", conversationId: state.activeId, turnId, versionIndex });
    void getAccessToken().then((token) =>
      token ? saveConversationSelection(state.activeId, turnId, version.id, token) : undefined,
    );
  };
  const copyPrompt = async (message: Message) => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopiedMessageId(message.id);
      window.setTimeout(() => setCopiedMessageId(null), 1400);
    } catch {}
  };
  const retryTurn = (turn: ConversationTurn) => {
    const version = turn.versions[turn.activeVersion];
    if (!version || activeStreaming) return Promise.resolve();
    return generation.sendMessage(
      version.user.content,
      turn.id,
      [],
      version.user.attachments ?? [],
      [],
      version.user.documents ?? [],
    );
  };
  const sharePrompt = async (message: Message) => {
    try {
      if (navigator.share) await navigator.share({ text: message.content });
      else await copyPrompt(message);
    } catch {}
  };
  const cancelLongPress = () => {
    if (longPressTimerRef.current === null) return;
    window.clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = null;
  };

  const cancelConversationLongPress = () => {
    if (conversationLongPressTimerRef.current === null) return;
    window.clearTimeout(conversationLongPressTimerRef.current);
    conversationLongPressTimerRef.current = null;
  };

  const startConversationLongPress = (conversationId: string, pointerType: string) => {
    cancelConversationLongPress();
    if (pointerType !== "touch") return;
    conversationLongPressTimerRef.current = window.setTimeout(() => {
      setOpenConversationActions(conversationId);
      conversationLongPressTimerRef.current = null;
    }, 500);
  };

  const requestDeleteConversation = (conversationId: string) => {
    if (deletingConversationId) return;
    setOpenConversationActions(null);
    setDeleteConversationError(null);
    setDeleteConversationId(conversationId);
  };

  const confirmDeleteConversation = async () => {
    const conversationId = deleteConversationId;
    if (!conversationId || deletingConversationId) return;
    const wasActive = conversationId === state.activeId;

    setDeletingConversationId(conversationId);
    setDeleteConversationError(null);
    try {
      await generation.stopStreaming(conversationId);
      const token = await getAccessToken();
      if (!token) throw new Error("Your session expired. Please sign in again.");
      await deleteConversation(conversationId, token);
      setConversationSummaries((current) =>
        current.filter(({ id }) => id !== conversationId),
      );
      if (loadingConversationId === conversationId) {
        conversationLoadRequestRef.current += 1;
        setLoadingConversationId(null);
      }
      const replacement = wasActive ? createConversation() : undefined;
      dispatch({ type: "REMOVE_CONVERSATION", conversationId, replacement });
      setRecoveredStreaming((current) => {
        if (!(conversationId in current)) return current;
        const next = { ...current };
        delete next[conversationId];
        return next;
      });
      if (wasActive) {
        setEditingTurnId(null);
        setEditingAttachments([]);
        setEditingDocuments([]);
        setDraft("");
        if (replacement) router.replace(`/chat/${replacement.id}`);
      }
      setDeleteConversationId(null);
    } catch (error) {
      setDeleteConversationError(error instanceof Error ? error.message : "The conversation could not be deleted.");
    } finally {
      setDeletingConversationId(null);
    }
  };
  const startLongPress = (turnId: string, pointerType: string) => {
    cancelLongPress();
    if (pointerType !== "touch") return;

    longPressTimerRef.current = window.setTimeout(() => {
      window.getSelection()?.removeAllRanges();
      setOpenMessageActions(turnId);
      longPressTimerRef.current = null;
    }, 500);
  };
  const sendMessage = (
    event?: FormEvent<HTMLFormElement>,
    attachments: readonly PendingChatImage[] = [],
    documents: readonly PendingChatDocument[] = [],
  ) => {
    event?.preventDefault();
    return generation.sendMessage(draft, editingTurnId, attachments, editingAttachments, documents, editingDocuments);
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  };
  const closeSettings = () => {
    setSettingsOpen(false);
    requestAnimationFrame(() => {
      const focusTarget = window.matchMedia("(max-width: 760px)").matches
        ? mobileMenuButtonRef.current
        : settingsButtonRef.current;
      focusTarget?.focus();
    });
  };

  if (!ready || !active) return <main className="loading-shell" aria-label="Loading chat" />;
  return (
    <main
      className={`app-shell ${pdfPreview ? "pdf-preview-open" : ""}`}
      style={pdfPreview ? ({
        "--pdf-preview-width": `${pdfPreviewWidth}px`,
      } as CSSProperties) : undefined}
      {...navigation}
    >
      <ChatSidebar
        sidebarOpen={sidebarOpen}
        conversations={sidebarConversations}
        activeConversationId={loadingConversationId ?? state.activeId}
        streamingByConversation={streamingByConversation}
        openConversationActions={openConversationActions}
        userEmail={user.email}
        mobileMenuButtonRef={mobileMenuButtonRef}
        settingsButtonRef={settingsButtonRef}
        onToggleSidebar={() => setSidebarOpen((open) => !open)}
        onCloseSidebar={() => setSidebarOpen(false)}
        onStartNewChat={startNewChat}
        onOpenSearch={() => {
          setSidebarOpen(false);
          setOpenConversationActions(null);
          setSearchOpen(true);
        }}
        onSelectConversation={selectConversation}
        onOpenConversationActions={setOpenConversationActions}
        onCloseConversationActions={() => setOpenConversationActions(null)}
        onStartConversationLongPress={startConversationLongPress}
        onCancelConversationLongPress={cancelConversationLongPress}
        onDeleteConversation={requestDeleteConversation}
        onOpenSettings={() => {
          setSidebarOpen(false);
          setOpenConversationActions(null);
          setSettingsOpen(true);
        }}
        onSignOut={onSignOut}
      />
      {searchOpen && (
        <ChatSearchDialog
          getAccessToken={getAccessToken}
          onClose={() => setSearchOpen(false)}
          onSelectConversation={selectConversation}
        />
      )}
      {deleteConversationId && (() => {
        const conversation = sidebarConversations.find(
          ({ id }) => id === deleteConversationId,
        );
        if (!conversation) return null;
        return (
          <DeleteConfirmationDialog
            conversationTitle={conversation.title}
            pending={deletingConversationId === deleteConversationId}
            error={deleteConversationError}
            onCancel={() => {
              if (!deletingConversationId) {
                setDeleteConversationId(null);
                setDeleteConversationError(null);
              }
            }}
            onConfirm={() => void confirmDeleteConversation()}
          />
        );
      })()}
      {settingsOpen && (
        <SettingsModal
          settings={settings}
          loadUsage={loadUsage}
          getAccessToken={getAccessToken}
          onClose={closeSettings}
          onSave={(next) => {
            setSettings(next);
            void getAccessToken().then((token) => token ? saveSettings(next, token) : undefined);
            closeSettings();
          }}
        />
      )}
      <section className={`chat-area ${active.turns.length ? "chat-active" : ""} ${openMessageActions ? "message-actions-active" : ""}`}>
        {openMessageActions && (
          <button
            type="button"
            className="message-actions-backdrop"
            aria-label="Close prompt actions"
            onClick={() => setOpenMessageActions(null)}
          />
        )}
        {loadingConversationId ? (
          <div
            className="conversation-loading"
            role="status"
            aria-label="Loading conversation"
          >
            Loading conversation…
          </div>
        ) : (
          <ChatTranscript
            conversationId={active.id}
            turns={active.turns}
            openMessageActions={openMessageActions}
            isStreamingConversation={activeStreaming || Boolean(loadingConversationId)}
            waitingByMessage={generation.waitingByMessage}
            thinkingByMessage={generation.thinkingByMessage}
            copiedMessageId={copiedMessageId}
            getAccessToken={getAccessToken}
            transcriptRef={transcriptRef}
            onTranscriptScroll={handleTranscriptScroll}
            onSetOpenMessageActions={setOpenMessageActions}
            onStartLongPress={startLongPress}
            onCancelLongPress={cancelLongPress}
            onSelectVersion={selectVersion}
            onCopy={copyPrompt}
            onRetry={retryTurn}
            onEdit={editTurn}
            onShare={sharePrompt}
            onOpenArtifact={openPdfPreview}
          />
        )}
        {conversationLoadError && !loadingConversationId && (
          <div role="alert">{conversationLoadError}</div>
        )}
        <ChatComposer
          key={`${active.id}:${attachmentResetKey}`}
          draft={draft}
          setDraft={setDraft}
          textareaRef={textareaRef}
          isStreaming={activeStreaming || Boolean(loadingConversationId)}
          models={preferences.models}
          model={preferences.model}
          setModel={preferences.setModel}
          selectedModel={preferences.selectedModel}
          openMenu={activeStreaming || loadingConversationId ? null : openMenu}
          setOpenMenu={setOpenMenu}
          thinking={preferences.thinking}
          setThinking={preferences.setThinking}
          effort={preferences.effort}
          setEffort={preferences.setEffort}
          onPreferenceChange={preferences.onPreferenceChange}
          supportedEfforts={preferences.supportedEfforts}
          canThink={preferences.canThink}
          effectiveThinking={preferences.effectiveThinking}
          effectiveEffort={preferences.effectiveEffort}
          editing={Boolean(editingTurnId)}
          preservedAttachments={editingAttachments}
          preservedDocuments={editingDocuments}
          onRemovePreservedAttachment={(imageId) => {
            setEditingAttachments((current) => current.filter((image) => image.id !== imageId));
          }}
          onRemovePreservedDocument={(documentId) => {
            setEditingDocuments((current) => current.filter((document) => document.id !== documentId));
          }}
          isSubmittingAttachments={generation.isSubmittingAttachments}
          isPreparingAttachments={generation.isPreparingAttachments}
          submissionError={generation.submissionError}
          onCancelEdit={() => {
            setEditingTurnId(null);
            setEditingAttachments([]);
            setEditingDocuments([]);
            setDraft("");
          }}
          onSubmit={sendMessage}
          onPrepareAttachments={generation.prepareChatImageUploads}
          onPrepareDocument={generation.prepareChatDocumentUpload}
          onCancelDocumentPreparation={generation.cancelChatDocumentPreparation}
          onKeyDown={handleKeyDown}
          onStop={() => void generation.stopStreaming()}
        />
      </section>
      {pdfPreview && (
        <PdfPreviewPanel
          artifact={pdfPreview.artifact}
          loadState={pdfPreview.loadState}
          width={pdfPreviewWidth}
          onWidthChange={setPdfPreviewWidth}
          onRetry={() => openPdfPreview(pdfPreview.artifact)}
          onClose={closePdfPreview}
        />
      )}
    </main>
  );
}
