"use client";

import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

type Conversation = {
  id: string;
  title: string;
  messages: Message[];
};

const STORAGE_KEY = "local-chat-conversations";

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
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState("");
  const [draft, setDraft] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const loadStoredChats = window.setTimeout(() => {
      try {
        const stored = localStorage.getItem(STORAGE_KEY);
        const parsed = stored ? (JSON.parse(stored) as Conversation[]) : [];
        const initial = parsed.length ? parsed : [createConversation()];
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
  }, []);

  useEffect(() => {
    if (ready) localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
  }, [conversations, ready]);

  const active = conversations.find((conversation) => conversation.id === activeId);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [active?.messages.length]);

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

  const sendMessage = (event?: FormEvent) => {
    event?.preventDefault();
    const content = draft.trim();
    if (!content || !activeId) return;

    const userMessage: Message = { id: makeId(), role: "user", content };
    const echoMessage: Message = { id: makeId(), role: "assistant", content };

    setConversations((current) =>
      current.map((conversation) =>
        conversation.id === activeId
          ? {
              ...conversation,
              title:
                conversation.messages.length === 0
                  ? content.slice(0, 42)
                  : conversation.title,
              messages: [...conversation.messages, userMessage, echoMessage],
            }
          : conversation,
      ),
    );
    setDraft("");
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
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
          <div className="avatar">U</div>
          <div>
            <div className="account-name">User</div>
            <div className="account-note">Local workspace</div>
          </div>
          <button className="more-button" type="button" aria-label="Account options">
            ···
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
                <div className="message-bubble">{message.content}</div>
              </article>
            ))}
            <div ref={endRef} />
          </div>
        )}

        <form className="composer-wrap" onSubmit={sendMessage}>
          <div className="composer">
            <textarea
              ref={textareaRef}
              value={draft}
              rows={1}
              aria-label="Message"
              placeholder="Message"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleKeyDown}
            />
            <div className="composer-actions">
              <button type="button" className="attach-button" aria-label="Attach a file">+</button>
              <span className="privacy-note">Messages stay on this device</span>
              <button
                type="submit"
                className="send-button"
                aria-label="Send message"
                disabled={!draft.trim()}
              >
                ↑
              </button>
            </div>
          </div>
          <p className="helper-text">Press Enter to send · Shift + Enter for a new line</p>
        </form>
      </section>
    </main>
  );
}
