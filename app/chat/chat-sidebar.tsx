"use client";

import type { RefObject } from "react";
import { ConversationActions } from "./conversation-actions";

export type SidebarConversation = {
  id: string;
  title: string;
};

export type ChatSidebarProps = {
  sidebarOpen: boolean;
  conversations: SidebarConversation[];
  activeConversationId: string;
  streamingByConversation: Record<string, string>;
  openConversationActions: string | null;
  userEmail: string;
  mobileMenuButtonRef: RefObject<HTMLButtonElement | null>;
  settingsButtonRef: RefObject<HTMLButtonElement | null>;
  onToggleSidebar: () => void;
  onCloseSidebar: () => void;
  onStartNewChat: () => void;
  onOpenSearch: () => void;
  onOpenProjects?: () => void;
  onSelectConversation: (conversationId: string) => void;
  onOpenConversationActions: (conversationId: string) => void;
  onCloseConversationActions: () => void;
  onStartConversationLongPress: (conversationId: string, pointerType: string) => void;
  onCancelConversationLongPress: () => void;
  onDeleteConversation: (conversationId: string) => void;
  onOpenSettings: () => void;
  onSignOut: () => void | Promise<void>;
};

/** Controlled conversation history/sidebar shell. */
export function ChatSidebar({
  sidebarOpen,
  conversations,
  activeConversationId,
  streamingByConversation,
  openConversationActions,
  userEmail,
  mobileMenuButtonRef,
  settingsButtonRef,
  onToggleSidebar,
  onCloseSidebar,
  onStartNewChat,
  onOpenSearch,
  onOpenProjects,
  onSelectConversation,
  onOpenConversationActions,
  onCloseConversationActions,
  onStartConversationLongPress,
  onCancelConversationLongPress,
  onDeleteConversation,
  onOpenSettings,
  onSignOut,
}: ChatSidebarProps) {
  return (
    <>
      <button
        ref={mobileMenuButtonRef}
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

        <button type="button" className="search-chat-button" onClick={onOpenSearch}>
          <span className="sidebar-search-icon" aria-hidden="true" />
          <span>Search chats</span>
        </button>

        <button type="button" className="search-chat-button" onClick={onOpenProjects}>
          <svg className="settings-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3.5 6.5h6l1.8 2h9.2v9.75a1.75 1.75 0 0 1-1.75 1.75H5.25a1.75 1.75 0 0 1-1.75-1.75V6.5Z" />
          </svg>
          <span>Projects</span>
        </button>

        <div className="history-label">Recent</div>
        <nav className="conversation-list" aria-label="Recent conversations">
          {conversations.map((conversation) => {
            const conversationIsStreaming = Boolean(streamingByConversation[conversation.id]);

            const actionsOpen = openConversationActions === conversation.id;

            return (
              <div className={`conversation-row ${actionsOpen ? "conversation-actions-open" : ""}`} key={conversation.id}>
                <button
                  type="button"
                  className={`conversation-item ${conversation.id === activeConversationId ? "active" : ""}`}
                  aria-expanded={actionsOpen}
                  onClick={() => {
                    if (actionsOpen) return;
                    onSelectConversation(conversation.id);
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    onOpenConversationActions(conversation.id);
                  }}
                  onPointerDown={(event) => onStartConversationLongPress(conversation.id, event.pointerType)}
                  onPointerUp={onCancelConversationLongPress}
                  onPointerCancel={onCancelConversationLongPress}
                  onPointerMove={onCancelConversationLongPress}
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
                <button
                  type="button"
                  className="conversation-delete-button"
                  aria-label={`Delete conversation: ${conversation.title}`}
                  onClick={() => onDeleteConversation(conversation.id)}
                >
                  <span aria-hidden="true">×</span>
                </button>
                {actionsOpen && (
                  <ConversationActions
                    onDelete={() => onDeleteConversation(conversation.id)}
                    onClose={onCloseConversationActions}
                  />
                )}
              </div>
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
            <svg className="settings-icon" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="3.5" />
              <path d="M12 2.75v2.1M12 19.15v2.1M21.25 12h-2.1M4.85 12h-2.1M18.54 5.46l-1.49 1.49M6.95 17.05l-1.49 1.49M18.54 18.54l-1.49-1.49M6.95 6.95 5.46 5.46" />
            </svg>
          </button>
          <div className="account-details">
            <div className="account-name">{userEmail}</div>
            <div className="account-note">Owner account</div>
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
