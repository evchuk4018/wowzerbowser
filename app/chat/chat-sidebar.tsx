"use client";

import type { RefObject } from "react";
import type { Conversation } from "./conversation-types";

export type ChatSidebarProps = {
  sidebarOpen: boolean;
  conversations: Conversation[];
  activeConversationId: string;
  streamingByConversation: Record<string, string>;
  userEmail: string;
  settingsButtonRef: RefObject<HTMLButtonElement | null>;
  onToggleSidebar: () => void;
  onCloseSidebar: () => void;
  onStartNewChat: () => void;
  onSelectConversation: (conversationId: string) => void;
  onOpenSettings: () => void;
  onSignOut: () => void | Promise<void>;
};

/** Controlled conversation history/sidebar shell. */
export function ChatSidebar({
  sidebarOpen,
  conversations,
  activeConversationId,
  streamingByConversation,
  userEmail,
  settingsButtonRef,
  onToggleSidebar,
  onCloseSidebar,
  onStartNewChat,
  onSelectConversation,
  onOpenSettings,
  onSignOut,
}: ChatSidebarProps) {
  return (
    <>
      <button
        className="mobile-menu"
        type="button"
        aria-label="Open conversation menu"
        aria-expanded={sidebarOpen}
        onClick={onToggleSidebar}
      >
        <span />
        <span />
      </button>

      {sidebarOpen && (
        <button
          type="button"
          className="sidebar-scrim"
          aria-label="Close conversation menu"
          onClick={onCloseSidebar}
        />
      )}

      <aside className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`}>
        <div className="sidebar-top">
          <div className="product-name">Chat</div>
          <button
            type="button"
            className="square-button"
            aria-label="Collapse sidebar"
            onClick={onCloseSidebar}
          >
            <span className="panel-icon" />
          </button>
        </div>

        <button type="button" className="new-chat-button" onClick={onStartNewChat}>
          <span className="plus-icon">+</span>
          <span>New chat</span>
          <kbd>Ctrl K</kbd>
        </button>

        <div className="history-label">Recent</div>
        <nav className="conversation-list" aria-label="Recent conversations">
          {conversations.map((conversation) => {
            const conversationIsStreaming = Boolean(streamingByConversation[conversation.id]);

            return (
              <button
                key={conversation.id}
                type="button"
                className={`conversation-item ${conversation.id === activeConversationId ? "active" : ""}`}
                onClick={() => onSelectConversation(conversation.id)}
              >
                <span className="conversation-title">{conversation.title}</span>
                {conversationIsStreaming && (
                  <span
                    className="conversation-streaming-bulb"
                    aria-label="Response in progress"
                    title="Response in progress"
                  />
                )}
              </button>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <button
            ref={settingsButtonRef}
            type="button"
            className="settings-button"
            aria-label="Open settings"
            onClick={onOpenSettings}
          >
            <span className="settings-icon" aria-hidden="true">⚙</span>
          </button>
          <div className="account-details">
            <div className="account-name">{userEmail}</div>
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
    </>
  );
}
