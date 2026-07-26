"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import type { AuthUser } from "../auth/types";
import { SettingsModal } from "../settings/settings-modal";
import { ChatComposer } from "./chat-composer";
import type { PendingChatImage } from "./chat-image-attachments";
import { ChatSidebar } from "./chat-sidebar";
import { ChatTranscript } from "./chat-transcript";
import { fetchChatUsage } from "./chat-usage-service";
import { createConversation, DEFAULT_CHAT_SETTINGS } from "./conversation-defaults";
import { DeleteConfirmationDialog } from "./delete-confirmation-dialog";
import { conversationReducer, createInitialConversationState } from "./conversation-reducer";
import {
  deleteConversation,
  loadConversations,
  loadSettings,
  saveConversationSelection,
  saveSettings,
  type LoadedConversations,
} from "./conversation-storage";
import type { ConversationTurn, Message } from "./conversation-types";
import { useChatGeneration } from "./use-chat-generation";
import { useChatPreferences } from "./use-chat-preferences";
import { useChatShortcuts } from "./use-chat-shortcuts";
import { useMobileHistoryNavigation } from "./use-mobile-history-navigation";
import { usePersistedJobRecovery } from "./use-persisted-job-recovery";
import type { ChatImageAttachment } from "../../lib/chat-protocol";

export type ChatWorkspaceProps = {
  user: AuthUser;
  getAccessToken: () => Promise<string | null>;
  onSignOut: () => Promise<void>;
};

export function ChatWorkspace({ user, getAccessToken, onSignOut }: ChatWorkspaceProps) {
  const [state, dispatch] = useReducer(conversationReducer, undefined, createInitialConversationState);
  const [ready, setReady] = useState(false);
  const [draft, setDraft] = useState("");
  const [attachmentResetKey, setAttachmentResetKey] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settings, setSettings] = useState(DEFAULT_CHAT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [openMenu, setOpenMenu] = useState<"model" | "thinking" | null>(null);
  const [openConversationActions, setOpenConversationActions] = useState<string | null>(null);
  const [deleteConversationId, setDeleteConversationId] = useState<string | null>(null);
  const [deleteConversationError, setDeleteConversationError] = useState<string | null>(null);
  const [deletingConversationId, setDeletingConversationId] = useState<string | null>(null);
  const [editingTurnId, setEditingTurnId] = useState<string | null>(null);
  const [editingAttachments, setEditingAttachments] = useState<ChatImageAttachment[]>([]);
  const [openMessageActions, setOpenMessageActions] = useState<string | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [recoveredStreaming, setRecoveredStreaming] = useState<Record<string, string>>({});
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const conversationLongPressTimerRef = useRef<number | null>(null);
  const loadUsage = useCallback(async (range: Parameters<typeof fetchChatUsage>[0]) => {
    const accessToken = await getAccessToken();
    if (!accessToken) throw new Error("Sign in to view usage.");
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return fetchChatUsage(range, timeZone, accessToken);
  }, [getAccessToken]);

  useEffect(() => {
    let mounted = true;
    void (async () => {
      let loaded: LoadedConversations = { conversations: [], streamingByConversation: {} };
      try {
        const token = await getAccessToken();
        if (token) loaded = await loadConversations(token);
      } catch {
        // Session/storage failures are nonfatal; start with a blank conversation.
      }
      if (!mounted) return;
      const conversations = loaded.conversations.length ? loaded.conversations : [createConversation()];
      dispatch({ type: "LOAD_CONVERSATIONS", conversations });
      setRecoveredStreaming(loaded.streamingByConversation);
      setReady(true);
    })();
    return () => {
      mounted = false;
    };
  }, [getAccessToken]);

  useEffect(() => {
    let mounted = true;
    void getAccessToken()
      .then((token) => token ? loadSettings(token) : DEFAULT_CHAT_SETTINGS)
      .then((value) => {
        if (mounted) setSettings(value);
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, [getAccessToken]);

  const preferences = useChatPreferences({
    activeConversationId: state.activeId,
    getAccessToken,
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

  const startNewChat = useCallback(() => {
    const blank = state.conversations.find(({ turns }) => turns.length === 0);
    if (blank) dispatch({ type: "SELECT_CONVERSATION", conversationId: blank.id });
    else dispatch({ type: "CREATE_CONVERSATION", conversation: createConversation() });
    setDraft("");
    setEditingTurnId(null);
    setEditingAttachments([]);
    setOpenMessageActions(null);
    setOpenConversationActions(null);
    setSidebarOpen(false);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [state.conversations]);

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
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [
    active?.turns.length,
    latestActivity?.kind,
    latestActivity?.status,
    latestMessage?.activities?.length,
    latestMessage?.artifacts?.length,
    latestMessage?.content.length,
    latestMessage?.reasoning?.length,
  ]);

  const selectConversation = (conversationId: string) => {
    dispatch({ type: "SELECT_CONVERSATION", conversationId });
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
    const conversation = state.conversations.find(({ id }) => id === conversationId);
    if (!conversation) {
      setDeleteConversationId(null);
      return;
    }

    setDeletingConversationId(conversationId);
    setDeleteConversationError(null);
    try {
      await generation.stopStreaming(conversationId);
      const token = await getAccessToken();
      if (!token) throw new Error("Your session expired. Please sign in again.");
      await deleteConversation(conversationId, token);
      const replacement = conversationId === state.activeId ? createConversation() : undefined;
      dispatch({ type: "REMOVE_CONVERSATION", conversationId, replacement });
      setRecoveredStreaming((current) => {
        if (!(conversationId in current)) return current;
        const next = { ...current };
        delete next[conversationId];
        return next;
      });
      if (conversationId === state.activeId) {
        setEditingTurnId(null);
        setEditingAttachments([]);
        setDraft("");
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
      setOpenMessageActions(turnId);
      longPressTimerRef.current = null;
    }, 500);
  };
  const sendMessage = (
    event?: FormEvent<HTMLFormElement>,
    attachments: readonly PendingChatImage[] = [],
  ) => {
    event?.preventDefault();
    return generation.sendMessage(draft, editingTurnId, attachments, editingAttachments);
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  };
  const closeSettings = () => {
    setSettingsOpen(false);
    requestAnimationFrame(() => settingsButtonRef.current?.focus());
  };

  if (!ready || !active) return <main className="loading-shell" aria-label="Loading chat" />;
  return (
    <main className="app-shell" {...navigation}>
      <ChatSidebar
        sidebarOpen={sidebarOpen}
        conversations={state.conversations}
        activeConversationId={state.activeId}
        streamingByConversation={streamingByConversation}
        openConversationActions={openConversationActions}
        userEmail={user.email}
        settingsButtonRef={settingsButtonRef}
        onToggleSidebar={() => setSidebarOpen((open) => !open)}
        onCloseSidebar={() => setSidebarOpen(false)}
        onStartNewChat={startNewChat}
        onSelectConversation={selectConversation}
        onOpenConversationActions={setOpenConversationActions}
        onCloseConversationActions={() => setOpenConversationActions(null)}
        onStartConversationLongPress={startConversationLongPress}
        onCancelConversationLongPress={cancelConversationLongPress}
        onDeleteConversation={requestDeleteConversation}
        onOpenSettings={() => setSettingsOpen(true)}
        onSignOut={onSignOut}
      />
      {deleteConversationId && (() => {
        const conversation = state.conversations.find(({ id }) => id === deleteConversationId);
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
        <ChatTranscript
          conversationId={active.id}
          turns={active.turns}
          openMessageActions={openMessageActions}
          isStreamingConversation={activeStreaming}
          waitingByMessage={generation.waitingByMessage}
          thinkingByMessage={generation.thinkingByMessage}
          copiedMessageId={copiedMessageId}
          getAccessToken={getAccessToken}
          endRef={endRef}
          onSetOpenMessageActions={setOpenMessageActions}
          onStartLongPress={startLongPress}
          onCancelLongPress={cancelLongPress}
          onSelectVersion={selectVersion}
          onCopy={copyPrompt}
          onEdit={editTurn}
          onShare={sharePrompt}
        />
        <ChatComposer
          key={`${active.id}:${attachmentResetKey}`}
          draft={draft}
          setDraft={setDraft}
          textareaRef={textareaRef}
          isStreaming={activeStreaming}
          models={preferences.models}
          model={preferences.model}
          setModel={preferences.setModel}
          selectedModel={preferences.selectedModel}
          openMenu={activeStreaming ? null : openMenu}
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
          onRemovePreservedAttachment={(imageId) => {
            setEditingAttachments((current) => current.filter((image) => image.id !== imageId));
          }}
          isSubmittingAttachments={generation.isSubmittingAttachments}
          isPreparingAttachments={generation.isPreparingAttachments}
          submissionError={generation.submissionError}
          onCancelEdit={() => {
            setEditingTurnId(null);
            setEditingAttachments([]);
            setDraft("");
          }}
          onSubmit={sendMessage}
          onPrepareAttachments={generation.prepareChatImageUploads}
          onKeyDown={handleKeyDown}
          onStop={() => void generation.stopStreaming()}
        />
      </section>
    </main>
  );
}
