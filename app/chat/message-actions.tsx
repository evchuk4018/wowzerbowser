"use client";

import type { ConversationTurn, Message } from "./conversation-types";

export type MessageActionsProps = {
  turn: ConversationTurn;
  message: Message;
  copiedMessageId: string | null;
  onCopy: (message: Message) => void | Promise<void>;
  onEdit: (turn: ConversationTurn) => void;
  onShare: (message: Message) => void | Promise<void>;
  onClose: () => void;
};

/** Controlled prompt actions popover used by each conversation turn. */
export function MessageActions({
  turn,
  message,
  copiedMessageId,
  onCopy,
  onEdit,
  onShare,
  onClose,
}: MessageActionsProps) {
  return (
    <div className="message-action-popover" role="menu" aria-label="Prompt actions">
      <div className="message-action-meta">Prompt actions</div>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          void onCopy(message);
          onClose();
        }}
      >
        <span className="message-action-icon" aria-hidden="true">▣</span>
        <span>{copiedMessageId === message.id ? "Copied" : "Copy"}</span>
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onEdit(turn);
          onClose();
        }}
      >
        <span className="message-action-icon" aria-hidden="true">⌕</span>
        <span>Edit</span>
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          void onShare(message);
          onClose();
        }}
      >
        <span className="message-action-icon" aria-hidden="true">↥</span>
        <span>Share prompt</span>
      </button>
    </div>
  );
}

