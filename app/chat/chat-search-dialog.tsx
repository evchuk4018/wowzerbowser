"use client";

import { useEffect, useRef, useState } from "react";
import type { ChatSearchResult } from "../../lib/chat-search";
import { fetchChatSearch } from "./chat-search-service";

export type ChatSearchDialogProps = {
  hasSession: () => Promise<boolean>;
  onClose: () => void;
  onSelectConversation: (conversationId: string) => void;
};

const SEARCH_DEBOUNCE_MS = 240;

function SearchIcon() {
  return <span className="search-icon" aria-hidden="true" />;
}

function ConversationIcon() {
  return <span className="search-result-icon" aria-hidden="true"><span /></span>;
}

export function ChatSearchDialog({ hasSession, onClose, onSelectConversation }: ChatSearchDialogProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ChatSearchResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled])",
      ));
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

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      void hasSession()
        .then((sessionReady) => {
          if (!sessionReady) throw new Error("Your session expired. Sign in and try again.");
          return fetchChatSearch(query, controller.signal);
        })
        .then((nextResults) => {
          if (!controller.signal.aborted) setResults(nextResults);
        })
        .catch((reason: unknown) => {
          if (controller.signal.aborted) return;
          setError(reason instanceof Error ? reason.message : "Search could not be completed.");
          setResults([]);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [hasSession, query]);

  return (
    <div
      className="chat-search-overlay"
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="chat-search-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="chat-search-title"
      >
        <div className="chat-search-heading">
          <h2 id="chat-search-title">Search chats</h2>
          <button type="button" className="chat-search-close" aria-label="Close search" onClick={onClose}>×</button>
        </div>
        <label className="chat-search-input-wrap">
          <SearchIcon />
          <input
            ref={inputRef}
            type="search"
            value={query}
            placeholder="Search chats"
            aria-label="Search chats"
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button type="button" className="chat-search-clear" aria-label="Clear search" onClick={() => setQuery("")}>×</button>
          )}
        </label>
        <div className="chat-search-results" aria-live="polite">
          {loading && <div className="chat-search-status">Searching…</div>}
          {!loading && error && <div className="chat-search-status chat-search-error">{error}</div>}
          {!loading && !error && !results.length && (
            <div className="chat-search-status">{query.trim() ? "No chats found." : "No recent chats."}</div>
          )}
          {!loading && !error && results.map((result) => (
            <button
              type="button"
              className="chat-search-result"
              key={result.id}
              onClick={() => {
                onClose();
                onSelectConversation(result.id);
              }}
            >
              <ConversationIcon />
              <span className="chat-search-result-copy">
                <strong>{result.title}</strong>
                <span>{result.preview || "No summary available."}</span>
              </span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
