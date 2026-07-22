"use client";

import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { MagicLinkForm } from "./auth/magic-link-form";
import type { AuthUser } from "./auth/types";
import { useAuthSession } from "./auth/use-auth-session";
import { fetchChatModels, streamChatResponse } from "./chat/chat-service";
import { ChatComposer } from "./chat/chat-composer";
import type {
  ChatModelId,
  ChatReasoningEffort,
} from "../lib/chat-protocol";
import { DEFAULT_CHAT_MODELS } from "../lib/chat-protocol";

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  thinkingEnabled?: boolean;
  thinkingDurationMs?: number;
  status?: "streaming" | "complete" | "error" | "cancelled";
  error?: string;
};

type Conversation = {
  id: string;
  title: string;
  messages: Message[];
};

type ChatSettings = {
  systemPrompt: string;
  userPresence: string;
};

const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful, thoughtful assistant. Always respond in English unless the user explicitly asks you to use another language. Be accurate, clear, and concise. If you are unsure, say so.";
const settingsStorageKeyFor = (userId: string) => `local-chat-settings:${userId}`;

const storageKeyFor = (userId: string) => `local-chat-conversations:${userId}`;
const LEGACY_STORAGE_KEY = "local-chat-conversations";

const makeId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;

const createConversation = (): Conversation => ({
  id: makeId(),
  title: "New conversation",
  messages: [],
});

export default function Home() {
  const {
    state,
    sendMagicLink,
    signInWithPassword,
    signUpWithPassword,
    signOut,
    getAccessToken,
  } = useAuthSession();

  if (state.status === "loading") {
    return <main className="loading-shell" aria-label="Loading session" />;
  }

  if (state.status !== "authenticated") {
    return (
      <MagicLinkForm
        error={state.status === "error" ? state.error : null}
        onSubmit={sendMagicLink}
        onPasswordSignIn={signInWithPassword}
        onPasswordSignUp={signUpWithPassword}
      />
    );
  }

  return (
    <ChatWorkspace
      key={state.user.id}
      user={state.user}
      getAccessToken={getAccessToken}
      onSignOut={signOut}
    />
  );
}

type ChatWorkspaceProps = {
  user: AuthUser;
  getAccessToken: () => Promise<string | null>;
  onSignOut: () => Promise<void>;
};

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) return `${Math.max(0, Math.round(milliseconds))}ms`;
  return `${(milliseconds / 1000).toFixed(1)}s`;
}

function ChatWorkspace({ user, getAccessToken, onSignOut }: ChatWorkspaceProps) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState("");
  const [draft, setDraft] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const [models, setModels] = useState(DEFAULT_CHAT_MODELS);
  const [model, setModel] = useState<ChatModelId>("deepseek-v4-flash");
  const [thinking, setThinking] = useState(false);
  const [effort, setEffort] = useState<ChatReasoningEffort>("high");
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null);
  const [thinkingMessageId, setThinkingMessageId] = useState<string | null>(null);
  const [thinkingNow, setThinkingNow] = useState(0);
  const [openMenu, setOpenMenu] = useState<"model" | "thinking" | null>(null);
  const [settings, setSettings] = useState<ChatSettings>({
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    userPresence: "",
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const thinkingStartedAtRef = useRef<number | null>(null);
  const activeRequestRef = useRef<{
    conversationId: string;
    messageId: string;
    controller: AbortController;
  } | null>(null);

  useEffect(() => {
    const loadStoredChats = window.setTimeout(() => {
      try {
        const userStorageKey = storageKeyFor(user.id);
        const userStored = localStorage.getItem(userStorageKey);
        const legacyStored = userStored ? null : localStorage.getItem(LEGACY_STORAGE_KEY);
        const stored = userStored ?? legacyStored;
        const parsed = stored ? (JSON.parse(stored) as Conversation[]) : [];
        const initial = parsed.length ? parsed : [createConversation()];
        if (legacyStored) localStorage.setItem(userStorageKey, legacyStored);
        setConversations(initial);
        setActiveId(initial[0].id);
      } catch {
        const initial = createConversation();
        setConversations([initial]);
        setActiveId(initial.id);
      }
      setReady(true);
    }, 0);

    return () => window.clearTimeout(loadStoredChats);
  }, [user.id]);

  useEffect(() => {
    if (ready) {
      localStorage.setItem(storageKeyFor(user.id), JSON.stringify(conversations));
    }
  }, [conversations, ready, user.id]);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(settingsStorageKeyFor(user.id));
      if (!stored) return;
      const parsed = JSON.parse(stored) as Partial<ChatSettings>;
      setSettings({
        systemPrompt:
          typeof parsed.systemPrompt === "string" && parsed.systemPrompt.trim()
            ? parsed.systemPrompt
            : DEFAULT_SYSTEM_PROMPT,
        userPresence: typeof parsed.userPresence === "string" ? parsed.userPresence : "",
      });
    } catch {
      setSettings({ systemPrompt: DEFAULT_SYSTEM_PROMPT, userPresence: "" });
    }
  }, [user.id]);

  useEffect(() => {
    let mounted = true;
    void getAccessToken()
      .then((token) => (token ? fetchChatModels(token) : []))
      .then((availableModels) => {
        if (mounted && availableModels.length) setModels(availableModels);
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, [getAccessToken]);

  const active = conversations.find((conversation) => conversation.id === activeId);
  const latestMessage = active ? active.messages[active.messages.length - 1] : undefined;
  const isStreaming = streamingMessageId !== null;
  const selectedModel = models.find((availableModel) => availableModel.id === model) ?? models[0];
  const supportedEfforts = useMemo(
    () => selectedModel?.supportedEfforts ?? [],
    [selectedModel],
  );
  const canThink = Boolean(selectedModel?.thinkingSupported && supportedEfforts.length);
  const effectiveThinking = thinking && canThink;
  const effectiveEffort = supportedEfforts.includes(effort)
    ? effort
    : (supportedEfforts[0] ?? "high");

  useEffect(() => {
    if (!models.length) return;
    const available = models.some((availableModel) => availableModel.id === model);
    if (!available) setModel(models[0].id);
  }, [model, models]);

  useEffect(() => {
    if (!canThink && thinking) setThinking(false);
    if (canThink && !supportedEfforts.includes(effort)) setEffort(supportedEfforts[0]);
  }, [canThink, effort, supportedEfforts, thinking]);

  useEffect(() => {
    const closeMenus = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest(".composer-menu")) {
        setOpenMenu(null);
      }
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpenMenu(null);
    };
    document.addEventListener("pointerdown", closeMenus);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeMenus);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  useEffect(() => {
    if (isStreaming) setOpenMenu(null);
  }, [isStreaming]);

  useEffect(() => {
    if (!thinkingMessageId || thinkingStartedAtRef.current === null) return;
    const update = () => {
      const startedAt = thinkingStartedAtRef.current;
      if (startedAt !== null) setThinkingNow(performance.now() - startedAt);
    };
    update();
    const timer = window.setInterval(update, 100);
    return () => window.clearInterval(timer);
  }, [thinkingMessageId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [active?.messages.length, latestMessage?.content.length, latestMessage?.reasoning?.length]);

  useEffect(() => {
    const handleShortcut = (event: globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        startNewChat();
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  });

  useEffect(() => {
    return () => activeRequestRef.current?.controller.abort();
  }, []);

  const startNewChat = () => {
    const existingBlank = conversations.find((item) => item.messages.length === 0);
    if (existingBlank) {
      setActiveId(existingBlank.id);
    } else {
      const next = createConversation();
      setConversations((current) => [next, ...current]);
      setActiveId(next.id);
    }
    setDraft("");
    setSidebarOpen(false);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const updateMessage = (
    conversationId: string,
    messageId: string,
    update: (message: Message) => Message,
  ) => {
    setConversations((current) =>
      current.map((conversation) =>
        conversation.id === conversationId
          ? {
              ...conversation,
              messages: conversation.messages.map((message) =>
                message.id === messageId ? update(message) : message,
              ),
            }
          : conversation,
      ),
    );
  };

  const stopStreaming = () => {
    const activeRequest = activeRequestRef.current;
    if (!activeRequest) return;
    activeRequest.controller.abort();
    updateMessage(activeRequest.conversationId, activeRequest.messageId, (message) => ({
      ...message,
      status: "cancelled",
    }));
    activeRequestRef.current = null;
    setStreamingMessageId(null);
    setThinkingMessageId(null);
    thinkingStartedAtRef.current = null;
  };

  const sendMessage = async (event?: FormEvent) => {
    event?.preventDefault();
    const content = draft.trim();
    if (!content || !activeId || isStreaming || !active) return;

    const userMessage: Message = { id: makeId(), role: "user", content };
    const assistantMessage: Message = {
      id: makeId(),
      role: "assistant",
      content: "",
      reasoning: "",
      thinkingEnabled: effectiveThinking,
      status: "streaming",
    };
    const conversationId = active.id;
    const requestMessages = [...active.messages, userMessage]
      .filter((message) => message.content.trim())
      .map(({ role, content: messageContent }) => ({ role, content: messageContent }));

    setConversations((current) =>
      current.map((conversation) =>
        conversation.id === conversationId
          ? {
              ...conversation,
              title:
                conversation.messages.length === 0 ? content.slice(0, 42) : conversation.title,
              messages: [...conversation.messages, userMessage, assistantMessage],
            }
          : conversation,
      ),
    );
    setDraft("");

    const controller = new AbortController();
    const requestThinkingStartedAt = effectiveThinking ? performance.now() : null;
    let requestThinkingFinished = false;
    activeRequestRef.current = {
      conversationId,
      messageId: assistantMessage.id,
      controller,
    };
    setStreamingMessageId(assistantMessage.id);
    if (requestThinkingStartedAt !== null) {
      thinkingStartedAtRef.current = requestThinkingStartedAt;
      setThinkingNow(0);
      setThinkingMessageId(assistantMessage.id);
    }

    let streamError = false;
    try {
      const accessToken = await getAccessToken();
      if (!accessToken) throw new Error("Your session expired. Please sign in again.");

      const request = {
        messages: requestMessages,
        systemPrompt: settings.systemPrompt,
        userPresence: settings.userPresence,
        model,
        thinking: effectiveThinking,
        reasoningEffort: effectiveEffort,
      };

      for await (const event of streamChatResponse(request, accessToken, controller.signal)) {
        if (event.type === "reasoning") {
          updateMessage(conversationId, assistantMessage.id, (message) => ({
            ...message,
            reasoning: `${message.reasoning ?? ""}${event.delta}`,
          }));
        } else if (event.type === "content") {
          if (requestThinkingStartedAt !== null && !requestThinkingFinished) {
            const duration = performance.now() - requestThinkingStartedAt;
            requestThinkingFinished = true;
            if (activeRequestRef.current?.messageId === assistantMessage.id) {
              thinkingStartedAtRef.current = null;
              setThinkingMessageId(null);
            }
            updateMessage(conversationId, assistantMessage.id, (message) => ({
              ...message,
              thinkingDurationMs: duration,
              content: `${message.content}${event.delta}`,
            }));
          } else {
            updateMessage(conversationId, assistantMessage.id, (message) => ({
              ...message,
              content: `${message.content}${event.delta}`,
            }));
          }
        } else if (event.type === "error") {
          streamError = true;
          updateMessage(conversationId, assistantMessage.id, (message) => ({
            ...message,
            status: "error",
            error: event.message,
          }));
        } else if (event.type === "done") {
          updateMessage(conversationId, assistantMessage.id, (message) => ({
            ...message,
            status: streamError ? "error" : "complete",
          }));
        }
      }
    } catch (error: unknown) {
      if (controller.signal.aborted) {
        updateMessage(conversationId, assistantMessage.id, (message) => ({
          ...message,
          status: "cancelled",
        }));
      } else {
        updateMessage(conversationId, assistantMessage.id, (message) => ({
          ...message,
          status: "error",
          error: error instanceof Error ? error.message : "The response failed.",
        }));
      }
    } finally {
      const isCurrentRequest = activeRequestRef.current?.messageId === assistantMessage.id;
      if (isCurrentRequest) {
        activeRequestRef.current = null;
        setStreamingMessageId(null);
        thinkingStartedAtRef.current = null;
        setThinkingMessageId(null);
      }
      if (requestThinkingStartedAt !== null && !requestThinkingFinished) {
        const duration = performance.now() - requestThinkingStartedAt;
        updateMessage(conversationId, assistantMessage.id, (message) => ({
          ...message,
          thinkingDurationMs: duration,
        }));
      }
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  };

  if (!ready || !active) return <main className="loading-shell" aria-label="Loading chat" />;

  const hasMessages = active.messages.length > 0;
  const closeSettings = () => {
    setSettingsOpen(false);
    requestAnimationFrame(() => settingsButtonRef.current?.focus());
  };

  return (
    <main className="app-shell">
      <button
        className="mobile-menu"
        type="button"
        aria-label="Open conversation menu"
        aria-expanded={sidebarOpen}
        onClick={() => setSidebarOpen((open) => !open)}
      >
        <span />
        <span />
      </button>

      {sidebarOpen && (
        <button
          type="button"
          className="sidebar-scrim"
          aria-label="Close conversation menu"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <aside className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`}>
        <div className="sidebar-top">
          <div className="product-name">Chat</div>
          <button type="button" className="square-button" aria-label="Collapse sidebar">
            <span className="panel-icon" />
          </button>
        </div>

        <button type="button" className="new-chat-button" onClick={startNewChat}>
          <span className="plus-icon">+</span>
          <span>New chat</span>
          <kbd>Ctrl K</kbd>
        </button>

        <div className="history-label">Recent</div>
        <nav className="conversation-list" aria-label="Recent conversations">
          {conversations.map((conversation) => (
            <button
              key={conversation.id}
              type="button"
              className={`conversation-item ${conversation.id === activeId ? "active" : ""}`}
              onClick={() => {
                setActiveId(conversation.id);
                setSidebarOpen(false);
              }}
            >
              {conversation.title}
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <button
            ref={settingsButtonRef}
            type="button"
            className="settings-button"
            aria-label="Open settings"
            onClick={() => setSettingsOpen(true)}
          >
            <span className="settings-icon" aria-hidden="true">⚙</span>
          </button>
          <div className="account-details">
            <div className="account-name">{user.email}</div>
            <div className="account-note">Magic link account</div>
          </div>
          <button
            className="sign-out-button"
            type="button"
            aria-label="Sign out"
            onClick={() => void onSignOut()}
          >
            Sign out
          </button>
        </div>
      </aside>

      {settingsOpen && (
        <SettingsModal
          settings={settings}
          onClose={closeSettings}
          onSave={(nextSettings) => {
            setSettings(nextSettings);
            try {
              localStorage.setItem(settingsStorageKeyFor(user.id), JSON.stringify(nextSettings));
            } catch {
              // Keep the setting active for this session if storage is unavailable.
            }
            closeSettings();
          }}
        />
      )}

      <section className={`chat-area ${hasMessages ? "chat-active" : ""}`}>
        {!hasMessages ? (
          <div className="empty-state">
            <div className="spark-mark" aria-hidden="true">✦</div>
            <h1>What can I help with?</h1>
            <p>Start a conversation below.</p>
          </div>
        ) : (
          <div className="transcript" aria-live="polite">
            {active.messages.map((message) => (
              <article key={message.id} className={`message ${message.role}`}>
                <div className="message-label">
                  {message.role === "user" ? "You" : "Response"}
                </div>
                {message.role === "assistant" &&
                  (Boolean(message.reasoning) ||
                    (message.thinkingEnabled && message.status === "streaming")) && (
                    <ReasoningBlock
                      message={message}
                      liveDurationMs={
                        thinkingMessageId === message.id ? Math.max(0, thinkingNow) : undefined
                      }
                    />
                  )}
                <div className="message-bubble">
                  {message.content ||
                    (message.status === "streaming" ? (
                      <span className="streaming-placeholder">Generating…</span>
                    ) : null)}
                </div>
                {message.error && <div className="message-error">{message.error}</div>}
                {message.status === "cancelled" && (
                  <div className="message-note">Response stopped.</div>
                )}
              </article>
            ))}
            <div ref={endRef} />
          </div>
        )}

        <ChatComposer
          draft={draft}
          setDraft={setDraft}
          textareaRef={textareaRef}
          isStreaming={isStreaming}
          models={models}
          model={model}
          setModel={setModel}
          selectedModel={selectedModel}
          openMenu={openMenu}
          setOpenMenu={setOpenMenu}
          thinking={thinking}
          setThinking={setThinking}
          effort={effort}
          setEffort={setEffort}
          supportedEfforts={supportedEfforts}
          canThink={canThink}
          effectiveThinking={effectiveThinking}
          effectiveEffort={effectiveEffort}
          onSubmit={(event) => void sendMessage(event)}
          onKeyDown={handleKeyDown}
          onStop={stopStreaming}
        />
      </section>
    </main>
  );
}

function SettingsModal({
  settings,
  onClose,
  onSave,
}: {
  settings: ChatSettings;
  onClose: () => void;
  onSave: (settings: ChatSettings) => void;
}) {
  const [draft, setDraft] = useState(settings);
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>("button, textarea"),
      ).filter((element) => !element.hasAttribute("disabled"));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <div className="settings-overlay" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section ref={dialogRef} className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div className="settings-header">
          <div>
            <div className="settings-kicker">Preferences</div>
            <h2 id="settings-title">Settings</h2>
          </div>
          <button type="button" className="settings-close" aria-label="Close settings" onClick={onClose}>×</button>
        </div>
        <label className="settings-field">
          <span>System prompt</span>
          <textarea
            value={draft.systemPrompt}
            maxLength={12000}
            onChange={(event) => setDraft((current) => ({ ...current, systemPrompt: event.target.value }))}
            rows={7}
          />
        </label>
        <label className="settings-field">
          <span>User presence</span>
          <textarea
            value={draft.userPresence}
            maxLength={12000}
            onChange={(event) => setDraft((current) => ({ ...current, userPresence: event.target.value }))}
            rows={5}
            placeholder="Optional context about you"
          />
        </label>
        <div className="settings-actions">
          <button type="button" className="settings-cancel" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="settings-save"
            disabled={!draft.systemPrompt.trim()}
            onClick={() => onSave({
              systemPrompt: draft.systemPrompt.trim(),
              userPresence: draft.userPresence.trim(),
            })}
          >
            Save
          </button>
        </div>
      </section>
    </div>
  );
}

function ReasoningBlock({
  message,
  liveDurationMs,
}: {
  message: Message;
  liveDurationMs?: number;
}) {
  const [open, setOpen] = useState(false);
  const duration = message.thinkingDurationMs ?? liveDurationMs;
  const isThinking = message.status === "streaming" && !message.content;

  return (
    <div className={`reasoning-block ${open ? "reasoning-open" : ""}`}>
      <button
        type="button"
        className="reasoning-summary"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="reasoning-chevron" aria-hidden="true">›</span>
        <span>{isThinking ? "Thinking" : "Thought process"}</span>
        {duration !== undefined && <span className="reasoning-duration">{formatDuration(duration)}</span>}
      </button>
      {open && (
        <div className="reasoning-content">
          {message.reasoning || (isThinking ? "Waiting for reasoning…" : "No reasoning returned.")}
        </div>
      )}
    </div>
  );
}
