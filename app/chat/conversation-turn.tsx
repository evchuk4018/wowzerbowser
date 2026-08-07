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
import { cancelChatJob, fetchChatImage, resumeChatJob } from "./chat-service";
import { memo, useEffect, useState } from "react";
import { loadChatImagePreview } from "./chat-image-preview-loader";
import { ConnectorApprovalModal } from "../settings/connector-approval-modal";

export type ThinkingTiming = { startedAt: number; now: number };

function UserImage({ image, conversationId, hasSession }: {
  image: ChatImageAttachment;
  conversationId: string;
  hasSession: () => Promise<boolean>;
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
      hasSession,
      fetchImage: (imageId, conversationId, signal) => fetchChatImage(imageId, conversationId, signal),
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
  }, [conversationId, hasSession, image.id, retryKey]);
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

function formatRunCost(costUsd: number): string {
  if (costUsd === 0) return "$0.00";
  if (costUsd >= 0.01) return `$${costUsd.toFixed(2)}`;
  if (costUsd >= 0.0001) return `$${costUsd.toFixed(4)}`;
  if (costUsd < 0.000001) return "<$0.000001";
  return `$${costUsd.toFixed(6)}`;
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
  hasSession: () => Promise<boolean>;
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
function ConversationTurnInner({
  conversationId,
  turn,
  actionsOpen,
  isStreamingConversation,
  waitingByMessage,
  thinkingByMessage,
  copiedMessageId,
  hasSession,
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
  const outputTps = assistantMessage.status === "complete"
    && typeof assistantMessage.streamMetrics?.outputTps === "number"
    && Number.isFinite(assistantMessage.streamMetrics.outputTps)
    ? `${assistantMessage.streamMetrics.outputTps.toFixed(1)} t/s`
    : null;
  const runCost = assistantMessage.status === "complete" && assistantMessage.streamMetrics?.runCost
    ? typeof assistantMessage.streamMetrics.runCost.costUsd === "number"
      && Number.isFinite(assistantMessage.streamMetrics.runCost.costUsd)
      && assistantMessage.streamMetrics.runCost.costUsd >= 0
      ? `${formatRunCost(assistantMessage.streamMetrics.runCost.costUsd)}${assistantMessage.streamMetrics.runCost.source === "estimated" ? " est." : ""}`
      : "Cost unavailable"
    : null;
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
                  <UserImage key={image.id} image={image} conversationId={conversationId} hasSession={hasSession} />
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
        {assistantMessage.experimentAssignment && (
          <div className="experiment-assignment-badge" title="This response was generated for an A/B experiment">
            {assistantMessage.experimentAssignment.experimentName} · {assistantMessage.experimentAssignment.variant.toUpperCase()}
          </div>
        )}
        {(assistantMessage.activities?.length ?? 0) > 0 || (assistantMessage.artifacts?.length ?? 0) > 0 ? (
          <AssistantActivityTimeline
            activities={assistantMessage.activities ?? []}
            content={assistantMessage.content}
            artifacts={assistantMessage.artifacts ?? []}
            annotations={assistantMessage.annotations}
            sources={assistantMessage.sources}
            hasSession={hasSession}
            onOpenArtifact={onOpenArtifact}
            streaming={assistantMessage.status === "streaming"}
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
              {assistantMessage.deepResearchPlan && (
                <div className="deep-research-plan" role="region" aria-label="Deep research plan">
                  <div className="deep-research-plan-title"><span aria-hidden="true">⌁</span> Deep research plan</div>
                  <p>We’ll investigate these topics, then consolidate the evidence into a report.</p>
                  <ol>{assistantMessage.deepResearchPlan.items.map((item) => <li key={item.id}><strong>{item.title}</strong><span>{item.question}</span></li>)}</ol>
                  {assistantMessage.status === "complete" && assistantMessage.jobId && (
                    <div className="deep-research-plan-actions">
                      <button type="button" onClick={() => void resumeChatJob(conversationId, assistantMessage.jobId!).then(() => window.location.reload())}>Proceed</button>
                      <button type="button" className="secondary" onClick={() => void cancelChatJob(conversationId, assistantMessage.jobId!).then(() => onEdit(turn))}>Revise</button>
                    </div>
                  )}
                </div>
              )}
              {assistantMessage.content ? (
                <AssistantResponse content={assistantMessage.content}
                  annotations={assistantMessage.annotations}
                  sources={assistantMessage.sources}
                  artifacts={assistantMessage.artifacts}
                  onOpenArtifact={onOpenArtifact}
                  streaming={assistantMessage.status === "streaming"}
                />
              ) : !assistantMessage.thinkingEnabled && waitingByMessage[assistantMessage.id] ? (
                <CallActivityIndicator />
              ) : null}
            </div>
            {assistantMessage.connectorApproval && (
              <ConnectorApprovalModal
                approval={assistantMessage.connectorApproval}
                hasSession={hasSession}
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
            {outputTps && <span className="response-tps" aria-label={`Response speed: ${outputTps}`}>{outputTps}</span>}
            {runCost && <span className="response-cost" aria-label={`Run cost: ${runCost}`}>{runCost}</span>}
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

function sameVersionList(left: ConversationTurnType, right: ConversationTurnType): boolean {
  if (left.versions.length !== right.versions.length) return false;
  return left.versions.every((version, index) => version === right.versions[index]);
}

function sameThinkingTiming(left: ThinkingTiming | undefined, right: ThinkingTiming | undefined): boolean {
  return left?.startedAt === right?.startedAt && left?.now === right?.now;
}

function areConversationTurnPropsEqual(previous: ConversationTurnProps, next: ConversationTurnProps): boolean {
  if (
    previous.conversationId !== next.conversationId
    || previous.actionsOpen !== next.actionsOpen
    || previous.isStreamingConversation !== next.isStreamingConversation
    || previous.hasSession !== next.hasSession
    || previous.onOpenArtifact !== next.onOpenArtifact
    || previous.turn.id !== next.turn.id
    || previous.turn.activeVersion !== next.turn.activeVersion
    || !sameVersionList(previous.turn, next.turn)
  ) return false;

  const previousAssistant = previous.turn.versions[previous.turn.activeVersion]?.assistant;
  const nextAssistant = next.turn.versions[next.turn.activeVersion]?.assistant;
  if (!previousAssistant || !nextAssistant) return previousAssistant === nextAssistant;

  return previous.waitingByMessage[previousAssistant.id] === next.waitingByMessage[nextAssistant.id]
    && sameThinkingTiming(previous.thinkingByMessage[previousAssistant.id], next.thinkingByMessage[nextAssistant.id])
    && (previous.copiedMessageId === previousAssistant.id) === (next.copiedMessageId === nextAssistant.id);
}

/**
 * Stream updates replace only the active version object. Keeping completed
 * turns memoized prevents those stable Markdown trees from being revisited.
 * Action callbacks are intentionally omitted: their stateful inputs are
 * represented by the compared props above, while the workspace handlers use
 * stable refs/setters for the remaining actions.
 */
export const ConversationTurn = memo(ConversationTurnInner, areConversationTurnPropsEqual);
