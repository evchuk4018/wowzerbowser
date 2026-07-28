"use client";

import { useEffect, type ChangeEvent } from "react";

export type ChatStartupShellProps = {
  draft: string;
  onDraftChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
};

export function ChatStartupShell({ draft, onDraftChange }: ChatStartupShellProps) {
  useEffect(() => {
    try {
      performance.mark("chat-shell-visible");
    } catch {}
  }, []);

  return (
    <main className="startup-shell" aria-label="Loading session">
      <aside className="startup-sidebar" aria-hidden="true">
        <div className="startup-sidebar-heading">Chat</div>
        <div className="startup-sidebar-button" />
        <div className="startup-sidebar-button startup-sidebar-button--short" />
        <div className="startup-sidebar-label">Recent</div>
        <div className="startup-sidebar-row" />
        <div className="startup-sidebar-row startup-sidebar-row--short" />
      </aside>
      <section className="startup-chat-area">
        <p className="sr-only" role="status">Restoring chat…</p>
        <div className="startup-composer-wrap">
          <form className="startup-composer" onSubmit={(event) => event.preventDefault()}>
            <textarea
              aria-label="Message"
              placeholder="Message"
              rows={1}
              value={draft}
              onChange={onDraftChange}
            />
            <div className="startup-composer-actions" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
          </form>
          <p className="helper-text">Restoring chat…</p>
        </div>
      </section>
    </main>
  );
}
