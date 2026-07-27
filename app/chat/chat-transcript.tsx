"use client";

import type { RefObject } from "react";
import { ConversationTurn, type ThinkingTiming } from "./conversation-turn";
import type { ConversationTurn as ConversationTurnType, Message } from "./conversation-types";

export type ChatTranscriptProps = {
  conversationId: string;
  turns: ConversationTurnType[];
  openMessageActions: string | null;
  isStreamingConversation: boolean;
  waitingByMessage: Record<string, boolean>;
  thinkingByMessage: Record<string, ThinkingTiming>;
  copiedMessageId: string | null;
  getAccessToken: () => Promise<string | null>;
  transcriptRef: RefObject<HTMLDivElement | null>;
  onTranscriptScroll: (element: HTMLDivElement) => void;
  onSetOpenMessageActions: (turnId: string | null) => void;
  onStartLongPress: (turnId: string, pointerType: string) => void;
  onCancelLongPress: () => void;
  onSelectVersion: (turnId: string, direction: -1 | 1) => void;
  onCopy: (message: Message) => void | Promise<void>;
  onRetry: (turn: ConversationTurnType) => void | Promise<void>;
  onEdit: (turn: ConversationTurnType) => void;
  onShare: (message: Message) => void | Promise<void>;
};

/** Transcript and empty state; state and network behavior stay in workspace. */
export function ChatTranscript({
  conversationId,
  turns,
  openMessageActions,
  isStreamingConversation,
  waitingByMessage,
  thinkingByMessage,
  copiedMessageId,
  getAccessToken,
  transcriptRef,
  onTranscriptScroll,
  onSetOpenMessageActions,
  onStartLongPress,
  onCancelLongPress,
  onSelectVersion,
  onCopy,
  onRetry,
  onEdit,
  onShare,
}: ChatTranscriptProps) {
  if (turns.length === 0) {
    return (
      <div className="empty-state">
        <div className="spark-mark" aria-hidden="true">✦</div>
        <h1>What can I help with?</h1>
        <p>Start a conversation below.</p>
      </div>
    );
  }

  return (
    <div
      ref={transcriptRef}
      className="transcript"
      aria-live="polite"
      onScroll={(event) => {
        onSetOpenMessageActions(null);
        onTranscriptScroll(event.currentTarget);
      }}
    >
      {turns.map((turn) => (
        <ConversationTurn
          key={turn.id}
          conversationId={conversationId}
          turn={turn}
          actionsOpen={openMessageActions === turn.id}
          isStreamingConversation={isStreamingConversation}
          waitingByMessage={waitingByMessage}
          thinkingByMessage={thinkingByMessage}
          copiedMessageId={copiedMessageId}
          getAccessToken={getAccessToken}
          onOpenActions={onSetOpenMessageActions}
          onCloseActions={() => onSetOpenMessageActions(null)}
          onStartLongPress={onStartLongPress}
          onCancelLongPress={onCancelLongPress}
          onSelectVersion={onSelectVersion}
          onCopy={onCopy}
          onRetry={onRetry}
          onEdit={onEdit}
          onShare={onShare}
        />
      ))}
    </div>
  );
}
