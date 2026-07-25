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
import { ChatSidebar } from "./chat-sidebar";
import { ChatTranscript } from "./chat-transcript";
import { createConversation, DEFAULT_CHAT_SETTINGS } from "./conversation-defaults";
import { conversationReducer, createInitialConversationState } from "./conversation-reducer";
import {
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

export type ChatWorkspaceProps = {
  user: AuthUser;
  getAccessToken: () => Promise<string | null>;
  onSignOut: () => Promise<void>;
};

export function ChatWorkspace({ user, getAccessToken, onSignOut }: ChatWorkspaceProps) {
  const [state, dispatch] = useReducer(conversationReducer, undefined, createInitialConversationState);
  const [ready, setReady] = useState(false);
  const [draft, setDraft] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settings, setSettings] = useState(DEFAULT_CHAT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [openMenu, setOpenMenu] = useState<"model" | "thinking" | null>(null);
  const [editingTurnId, setEditingTurnId] = useState<string | null>(null);
  const [openMessageActions, setOpenMessageActions] = useState<string | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [recoveredStreaming, setRecoveredStreaming] = useState<Record<string, string>>({});
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const longPressTimerRef = useRef<number | null>(null);

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
    onEditingConsumed: () => setEditingTurnId(null),
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
    setOpenMessageActions(null);
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
    },
  });

  useEffect(() => {
    const closeMenus = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest(".composer-menu")) setOpenMenu(null);
      if (openMessageActions && (!(event.target instanceof Element) || !event.target.closest(".message-action-popover"))) {
        setOpenMessageActions(null);
      }
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpenMenu(null);
        setOpenMessageActions(null);
      }
    };
    document.addEventListener("pointerdown", closeMenus);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeMenus);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openMessageActions]);

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
    setSidebarOpen(false);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };
  const editTurn = (turn: ConversationTurn) => {
    const version = turn.versions[turn.activeVersion];
    if (!version) return;
    setDraft(version.user.content);
    setEditingTurnId(turn.id);
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
  const startLongPress = (turnId: string, pointerType: string) => {
    cancelLongPress();
    if (pointerType !== "touch") return;
    longPressTimerRef.current = window.setTimeout(() => {
      setOpenMessageActions(turnId);
      longPressTimerRef.current = null;
    }, 500);
  };
  const sendMessage = (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    return generation.sendMessage(draft, editingTurnId);
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
        userEmail={user.email}
        settingsButtonRef={settingsButtonRef}
        onToggleSidebar={() => setSidebarOpen((open) => !open)}
        onCloseSidebar={() => setSidebarOpen(false)}
        onStartNewChat={startNewChat}
        onSelectConversation={selectConversation}
        onOpenSettings={() => setSettingsOpen(true)}
        onSignOut={onSignOut}
      />
      {settingsOpen && (
        <SettingsModal
          settings={settings}
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
          onCancelEdit={() => {
            setEditingTurnId(null);
            setDraft("");
          }}
          onSubmit={sendMessage}
          onKeyDown={handleKeyDown}
          onStop={() => void generation.stopStreaming()}
        />
      </section>
    </main>
  );
}
