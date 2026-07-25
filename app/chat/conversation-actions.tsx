"use client";

export type ConversationActionsProps = {
  onDelete: () => void;
  onClose: () => void;
};

/** Mobile conversation actions shown after a history-row long press. */
export function ConversationActions({ onDelete, onClose }: ConversationActionsProps) {
  return (
    <div className="conversation-action-popover" role="menu" aria-label="Conversation actions">
      <div className="conversation-action-meta">Chat actions</div>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onDelete();
          onClose();
        }}
      >
        <span className="conversation-action-icon" aria-hidden="true">×</span>
        <span>Delete</span>
      </button>
      <button type="button" role="menuitem" disabled>
        <span className="conversation-action-icon" aria-hidden="true">⌕</span>
        <span>Rename</span>
      </button>
    </div>
  );
}
