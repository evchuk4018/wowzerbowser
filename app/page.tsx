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
          <div className="avatar">{user.email.charAt(0).toUpperCase()}</div>
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
