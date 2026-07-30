"use client";

import type { PointerEvent as ReactPointerEvent } from "react";
import { AssistantActivityTimeline } from "./assistant-activity";
import { AssistantResponse } from "./assistant-response";
import type { ConversationTurn as ConversationTurnType, Message } from "./conversation-types";
import { MessageActions } from "./message-actions";
import { ReasoningBlock } from "./reasoning-block";
import { CallActivityIndicator } from "./call-activity-indicator";
import type { ChatArtifact, ChatImageAttachment } from "../../lib/chat-protocol";
import type { ChatDocumentAttachment } from "../../lib/chat-document";
import { fetchChatImage } from "./chat-service";
import { useEffect, useState } from "react";
import { loadChatImagePreview } from "./chat-image-preview-loader";
import { ConnectorApprovalModal } from "../settings/connector-approval-modal";

export type ThinkingTiming = { startedAt: number; now: number };

function UserImage({ image, conversationId, getAccessToken }: {
  image: ChatImageAttachment;
  conversationId: string;
  getAccessToken: () => Promise<string | null>;
}) {
  const [preview, setPreview] = useState<{ status: "loading" | "loaded" | "error"; url?: string }>({ status: "loading" });
  const [retryKey, setRetryKey] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | null = null;
    void loadChatImagePreview({
      imageId: image.id,
      conversationId,
      signal: controller.signal,
      getAccessToken,
      fetchImage: fetchChatImage,
    })
      .then((blob) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setPreview({ status: "loaded", url: objectUrl });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          console.error("Image preview could not be loaded.", error);
          setPreview({ status: "error" });
        }
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [conversationId, getAccessToken, image.id, retryKey]);
  return (
    <div className="message-image-attachment">
      <div className="message-image-preview">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {preview.status === "loaded" ? <img src={preview.url} alt={image.name ?? "Attached image"} /> : null}
        {preview.status === "loading" ? <span>Loading image…</span> : null}
        {preview.status === "error" ? <span>Image unavailable <button type="button" onClick={() => { setPreview({ status: "loading" }); setRetryKey((key) => key + 1); }}>Retry</button></span> : null}
      </div>
      {image.name && <span className="message-image-name" title={image.name}>{image.name}</span>}
    </div>
  );
}

function formatDocumentSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function UserDocument({ document }: { document: ChatDocumentAttachment }) {
  const isPdf = document.contentType === "application/pdf";
  const type = isPdf ? "PDF" : "DOCX";
  const pages = `${document.pageCount} ${document.pageCount === 1 ? "page" : "pages"}`;

  return (
    <div
      className={`message-document-attachment message-document-attachment--${type.toLowerCase()}`}
      role="group"
      aria-label={`${type} document: ${document.name}, ${formatDocumentSize(document.size)}, ${pages}`}
    >
      <span className="message-document-icon" aria-hidden="true">
        <span className="message-document-icon-fold" />
        <span className="message-document-type">{type}</span>
      </span>
      <span className="message-document-details">
        <span className="message-document-name" title={document.name}>{document.name}</span>
        <span className="message-document-meta" aria-hidden="true">
          {type} <span aria-hidden="true">·</span> {formatDocumentSize(document.size)} <span aria-hidden="true">·</span> {pages}
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
  onRetry: (turn: ConversationTurnType) => void | Promise<void>;
  onEdit: (turn: ConversationTurnType) => void;
  onShare: (message: Message) => void | Promise<void>;
  onOpenArtifact: (artifact: ChatArtifact) => void;
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
  onRetry,
  onEdit,
  onShare,
  onOpenArtifact,
}: ConversationTurnProps) {
  const version = turn.versions[turn.activeVersion];
  if (!version) return null;
  const userMessage = version.user;
  const assistantMessage = version.assistant;
  const hasUserAttachments = Boolean(userMessage.attachments?.length || userMessage.documents?.length);
  const handleContextMenu = (event: React.MouseEvent<HTMLElement>) => {
    event.preventDefault();
    onOpenActions(turn.id);
  };
  const handlePointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    onStartLongPress(turn.id, event.pointerType);
  };

  return (
    <article className={`message-pair ${actionsOpen ? "message-actions-open" : ""}`}>
      <div className="message-user-container">
        <article className="message user">
          <div className="message-label">You</div>
          <div
            className={`message-bubble ${hasUserAttachments ? "message-bubble--with-attachments" : ""}`}
            onContextMenu={handleContextMenu}
            onPointerDown={handlePointerDown}
            onPointerUp={onCancelLongPress}
            onPointerCancel={onCancelLongPress}
            onPointerMove={onCancelLongPress}
          >
            {userMessage.attachments?.length ? (
              <div className="message-image-attachments">
                {userMessage.attachments.map((image) => (
                  <UserImage key={image.id} image={image} conversationId={conversationId} getAccessToken={getAccessToken} />
                ))}
              </div>
            ) : null}
            {userMessage.documents?.length ? (
              <div className="message-document-attachments" role="group" aria-label="Attached documents">
                {userMessage.documents.map((document) => (
                  <UserDocument key={document.id} document={document} />
                ))}
              </div>
            ) : null}
            {userMessage.content ? <div className="message-user-content">{userMessage.content}</div> : null}
          </div>
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
            annotations={assistantMessage.annotations}
            sources={assistantMessage.sources}
            getAccessToken={getAccessToken}
            onOpenArtifact={onOpenArtifact}
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
                <AssistantResponse content={assistantMessage.content}
                  annotations={assistantMessage.annotations}
                  sources={assistantMessage.sources}
                  artifacts={assistantMessage.artifacts}
                  onOpenArtifact={onOpenArtifact}
                />
              ) : !assistantMessage.thinkingEnabled && waitingByMessage[assistantMessage.id] ? (
                <CallActivityIndicator />
              ) : null}
            </div>
            {assistantMessage.connectorApproval && (
              <ConnectorApprovalModal
                approval={assistantMessage.connectorApproval}
                getAccessToken={getAccessToken}
              />
            )}
          </>
        )}
        {assistantMessage.error && <div className="message-error">{assistantMessage.error}</div>}
        {assistantMessage.status === "cancelled" && <div className="message-note">Response stopped.</div>}
        <div className="response-controls">
          <div className="response-actions" role="group" aria-label="Response actions">
            <button
              type="button"
              className={copiedMessageId === assistantMessage.id ? "is-copied" : undefined}
              disabled={isStreamingConversation || !assistantMessage.content}
              aria-label={copiedMessageId === assistantMessage.id ? "Response copied" : "Copy response"}
              onClick={() => void onCopy(assistantMessage)}
            >
              <svg className="response-action-icon" viewBox="0 0 20 20" aria-hidden="true">
                <rect x="6.5" y="6.5" width="9" height="9" rx="1.5" />
                <path d="M4.5 13.5h-1a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v1" />
              </svg>
              <span>{copiedMessageId === assistantMessage.id ? "Copied" : "Copy"}</span>
            </button>
            <button
              type="button"
              disabled={isStreamingConversation}
              aria-label="Retry this response"
              onClick={() => void onRetry(turn)}
            >
              <svg className="response-action-icon" viewBox="0 0 20 20" aria-hidden="true">
                <path d="M15.5 6.5V3m0 3.5H12" />
                <path d="M15.1 6.4A6.5 6.5 0 1 0 16 13" />
              </svg>
              <span>Retry</span>
            </button>
            <span className="visually-hidden" aria-live="polite">
              {copiedMessageId === assistantMessage.id ? "Response copied to clipboard." : ""}
            </span>
          </div>
          {turn.versions.length > 1 && (
            <div className="version-controls" role="group" aria-label="Response versions">
              <button
                type="button"
                aria-label="Show previous response version"
                disabled={turn.activeVersion === 0 || isStreamingConversation}
                onClick={() => onSelectVersion(turn.id, -1)}
              >
                <span aria-hidden="true">‹</span>
              </button>
              <span aria-live="polite">Response {turn.activeVersion + 1} of {turn.versions.length}</span>
              <button
                type="button"
                aria-label="Show next response version"
                disabled={turn.activeVersion === turn.versions.length - 1 || isStreamingConversation}
                onClick={() => onSelectVersion(turn.id, 1)}
              >
                <span aria-hidden="true">›</span>
              </button>
            </div>
          )}
        </div>
      </article>
    </article>
  );
}
