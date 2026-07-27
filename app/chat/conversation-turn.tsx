"use client";

import type { PointerEvent as ReactPointerEvent } from "react";
import { AssistantActivityTimeline } from "./assistant-activity";
import { AssistantResponse } from "./assistant-response";
import type { ConversationTurn as ConversationTurnType, Message } from "./conversation-types";
import { MessageActions } from "./message-actions";
import { ReasoningBlock } from "./reasoning-block";
import { CallActivityIndicator } from "./call-activity-indicator";
import type { ChatImageAttachment } from "../../lib/chat-protocol";
import type { ChatDocumentAttachment } from "../../lib/chat-document";
import { fetchChatImage } from "./chat-service";
import { useEffect, useState } from "react";

export type ThinkingTiming = { startedAt: number; now: number };

function UserImage({ image, conversationId, getAccessToken }: {
  image: ChatImageAttachment;
  conversationId: string;
  getAccessToken: () => Promise<string | null>;
}) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    void getAccessToken()
      .then((token) => token ? fetchChatImage(image.id, conversationId, token) : null)
      .then((blob) => {
        if (!blob || !active) return;
        objectUrl = URL.createObjectURL(blob);
        setPreviewUrl(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [conversationId, getAccessToken, image.id]);
  return (
    <div className="message-image-attachment">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {previewUrl ? <img src={previewUrl} alt={image.name ?? "Attached image"} /> : <span>Loading image…</span>}
      {image.name && <span>{image.name}</span>}
    </div>
  );
}

function formatDocumentSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function UserDocument({ document }: { document: ChatDocumentAttachment }) {
  const type = document.contentType === "application/pdf" ? "PDF" : "DOCX";
  const pages = `${document.pageCount} ${document.pageCount === 1 ? "page" : "pages"}`;

  return (
    <div
      className="message-document-attachment"
      aria-label={`${type} document: ${document.name}, ${formatDocumentSize(document.size)}, ${pages}`}
    >
      <span className="message-document-type" aria-hidden="true">{type}</span>
      <span className="message-document-details">
        <span className="message-document-name" title={document.name}>{document.name}</span>
        <span className="message-document-meta" aria-hidden="true">
          {formatDocumentSize(document.size)} <span aria-hidden="true">·</span> {pages}
        </span>
      </span>
    </div>
  );
}

export type ConversationTurnProps = {
  conversationId: string;
  turn: ConversationTurnType;
  actionsOpen: boolean;
  isStreamingConversation: boolean;
  waitingByMessage: Record<string, boolean>;
  thinkingByMessage: Record<string, ThinkingTiming>;
  copiedMessageId: string | null;
  getAccessToken: () => Promise<string | null>;
  onOpenActions: (turnId: string) => void;
  onCloseActions: () => void;
  onStartLongPress: (turnId: string, pointerType: string) => void;
  onCancelLongPress: () => void;
  onSelectVersion: (turnId: string, direction: -1 | 1) => void;
  onCopy: (message: Message) => void | Promise<void>;
  onEdit: (turn: ConversationTurnType) => void;
  onShare: (message: Message) => void | Promise<void>;
};

/** Render one user prompt and its assistant response without owning state. */
export function ConversationTurn({
  conversationId,
  turn,
  actionsOpen,
  isStreamingConversation,
  waitingByMessage,
  thinkingByMessage,
  copiedMessageId,
  getAccessToken,
  onOpenActions,
  onCloseActions,
  onStartLongPress,
  onCancelLongPress,
  onSelectVersion,
  onCopy,
  onEdit,
  onShare,
}: ConversationTurnProps) {
  const version = turn.versions[turn.activeVersion];
  if (!version) return null;
  const userMessage = version.user;
  const assistantMessage = version.assistant;
  const handleContextMenu = (event: React.MouseEvent<HTMLElement>) => {
    event.preventDefault();
    onOpenActions(turn.id);
  };
  const handlePointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    onStartLongPress(turn.id, event.pointerType);
  };

  return (
    <article
      className={`message-pair ${actionsOpen ? "message-actions-open" : ""}`}
      onContextMenu={handleContextMenu}
      onPointerDown={handlePointerDown}
      onPointerUp={onCancelLongPress}
      onPointerCancel={onCancelLongPress}
      onPointerMove={onCancelLongPress}
    >
      <div className="message-user-container">
        <article className="message user">
          <div className="message-label">You</div>
          <div className="message-bubble">
            {userMessage.attachments?.length ? (
              <div className="message-image-attachments">
                {userMessage.attachments.map((image) => (
                  <UserImage key={image.id} image={image} conversationId={conversationId} getAccessToken={getAccessToken} />
                ))}
              </div>
            ) : null}
            {userMessage.documents?.length ? (
              <div className="message-document-attachments" aria-label="Attached documents">
                {userMessage.documents.map((document) => (
                  <UserDocument key={document.id} document={document} />
                ))}
              </div>
            ) : null}
            {userMessage.content}
          </div>
          {turn.versions.length > 1 && (
            <div className="version-controls" aria-label="Prompt versions">
              <button
                type="button"
                aria-label="Previous prompt version"
                disabled={turn.activeVersion === 0 || isStreamingConversation}
                onClick={() => onSelectVersion(turn.id, -1)}
              >
                ‹
              </button>
              <span>{turn.activeVersion + 1} / {turn.versions.length}</span>
              <button
                type="button"
                aria-label="Next prompt version"
                disabled={turn.activeVersion === turn.versions.length - 1 || isStreamingConversation}
                onClick={() => onSelectVersion(turn.id, 1)}
              >
                ›
              </button>
            </div>
          )}
        </article>
        {actionsOpen && (
          <MessageActions
            turn={turn}
            message={userMessage}
            copiedMessageId={copiedMessageId}
            onCopy={onCopy}
            onEdit={onEdit}
            onShare={onShare}
            onClose={onCloseActions}
          />
        )}
      </div>
      <article className="message assistant">
        <div className="message-label">Response</div>
        {(assistantMessage.activities?.length ?? 0) > 0 || (assistantMessage.artifacts?.length ?? 0) > 0 ? (
          <AssistantActivityTimeline
            activities={assistantMessage.activities ?? []}
            content={assistantMessage.content}
            artifacts={assistantMessage.artifacts ?? []}
            getAccessToken={getAccessToken}
          />
        ) : (
          <>
            {Boolean(assistantMessage.reasoning) && (
              <ReasoningBlock
                message={assistantMessage}
                liveDurationMs={
                  thinkingByMessage[assistantMessage.id]
                    ? Math.max(
                        0,
                        thinkingByMessage[assistantMessage.id].now -
                          thinkingByMessage[assistantMessage.id].startedAt,
                      )
                    : undefined
                }
              />
            )}
            <div className="message-bubble">
              {assistantMessage.content ? (
                <AssistantResponse content={assistantMessage.content} />
              ) : !assistantMessage.thinkingEnabled && waitingByMessage[assistantMessage.id] ? (
                <CallActivityIndicator />
              ) : null}
            </div>
          </>
        )}
        {assistantMessage.error && <div className="message-error">{assistantMessage.error}</div>}
        {assistantMessage.status === "cancelled" && <div className="message-note">Response stopped.</div>}
      </article>
    </article>
  );
}
