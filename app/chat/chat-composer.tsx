"use client";

import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type Dispatch,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
  type SetStateAction,
} from "react";
import type { ChatImageAttachment, ChatModelId, ChatModelInfo, ChatReasoningEffort } from "../../lib/chat-protocol";
import type { ChatModelPreference } from "../../lib/chat-model-preference";
import {
  ACCEPTED_CHAT_IMAGE_TYPES,
  type PendingChatImage,
  validateChatImages,
} from "./chat-image-attachments";
import { validateChatDocument, type PendingChatDocument } from "./chat-document-attachments";
import { DOCX_CONTENT_TYPE, DOCUMENT_CONTENT_TYPES, type ChatDocumentAttachment } from "../../lib/chat-document";

function formatDocumentSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function documentType(contentType: string, name: string): "PDF" | "DOCX" {
  if (contentType === "application/pdf") return "PDF";
  if (contentType === DOCX_CONTENT_TYPE) return "DOCX";
  return name.toLowerCase().endsWith(".pdf") ? "PDF" : "DOCX";
}

function DocumentIcon({ type }: { type: "PDF" | "DOCX" }) {
  return (
    <span className="message-document-icon" aria-hidden="true">
      <span className="message-document-icon-fold" />
      <span className="message-document-type">{type}</span>
    </span>
  );
}

export type ChatComposerProps = {
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  isStreaming: boolean;
  startupPending?: boolean;
  models: ChatModelInfo[];
  model: ChatModelId;
  setModel: Dispatch<SetStateAction<ChatModelId>>;
  selectedModel?: ChatModelInfo;
  openMenu: "model" | "thinking" | null;
  setOpenMenu: Dispatch<SetStateAction<"model" | "thinking" | null>>;
  thinking: boolean;
  setThinking: Dispatch<SetStateAction<boolean>>;
  effort: ChatReasoningEffort;
  setEffort: Dispatch<SetStateAction<ChatReasoningEffort>>;
  onPreferenceChange: (preference: ChatModelPreference) => void;
  supportedEfforts: ChatReasoningEffort[];
  canThink: boolean;
  effectiveThinking: boolean;
  effectiveEffort: ChatReasoningEffort;
  editing: boolean;
  preservedAttachments?: readonly ChatImageAttachment[];
  onRemovePreservedAttachment?: (imageId: string) => void;
  preservedDocuments?: readonly ChatDocumentAttachment[];
  onRemovePreservedDocument?: (documentId: string) => void;
  isSubmittingAttachments: boolean;
  isPreparingAttachments: boolean;
  submissionError?: string | null;
  onCancelEdit: () => void;
  onSubmit: (event?: FormEvent<HTMLFormElement>, attachments?: readonly PendingChatImage[], documents?: readonly PendingChatDocument[]) => void | Promise<void>;
  onPrepareAttachments?: (attachments: readonly PendingChatImage[]) => PendingChatImage[];
  onPrepareDocument: (document: PendingChatDocument) => PendingChatDocument;
  onCancelDocumentPreparation: (document: PendingChatDocument) => Promise<void>;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onStop: () => void;
};

export function ChatComposer({
  draft,
  setDraft,
  textareaRef,
  isStreaming,
  startupPending = false,
  models,
  model,
  setModel,
  selectedModel,
  openMenu,
  setOpenMenu,
  thinking,
  setThinking,
  effort,
  setEffort,
  onPreferenceChange,
  supportedEfforts,
  canThink,
  effectiveThinking,
  effectiveEffort,
  editing,
  preservedAttachments = [],
  onRemovePreservedAttachment,
  preservedDocuments = [],
  onRemovePreservedDocument,
  isSubmittingAttachments,
  isPreparingAttachments,
  submissionError,
  onCancelEdit,
  onSubmit,
  onPrepareAttachments,
  onPrepareDocument,
  onCancelDocumentPreparation,
  onKeyDown,
  onStop,
}: ChatComposerProps) {
  const [attachments, setAttachments] = useState<PendingChatImage[]>([]);
  const [documents, setDocuments] = useState<PendingChatDocument[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachmentsRef = useRef(attachments);
  const documentsRef = useRef(documents);
  const disabled = isStreaming || isSubmittingAttachments || startupPending;

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    documentsRef.current = documents;
  }, [documents]);

  useEffect(() => () => {
    attachmentsRef.current.forEach(({ previewUrl }) => URL.revokeObjectURL(previewUrl));
    documentsRef.current.forEach((document) => {
      if (!document.consumed) void onCancelDocumentPreparation(document);
    });
  }, [onCancelDocumentPreparation]);

  const addFiles = (files: readonly File[]) => {
    if (startupPending) return;
    if (!files.length) return;
    const pdfs=files.filter((file) => {
      const name = file.name.toLowerCase();
      return DOCUMENT_CONTENT_TYPES.includes(file.type as never) || name.endsWith(".doc") || name.endsWith(".docx");
    });
    const images = files.filter((file) => !pdfs.includes(file));
    const error = pdfs.length > 1 || documents.length + pdfs.length > 1 ? "Attach one document per message." : (pdfs[0] ? validateChatDocument(pdfs[0]) : validateChatImages(images, attachments.length));
    if (error) {
      setAttachmentError(error);
      return;
    }
    setAttachmentError(null);
    if (pdfs.length) {
      const preparedDocuments = pdfs.map((file) =>
        onPrepareDocument({ id: crypto.randomUUID(), file }),
      );
      setDocuments((current) => current.concat(preparedDocuments));
    }
    const next = images.map((file) => ({
      id: crypto.randomUUID(),
      file,
      previewUrl: URL.createObjectURL(file),
    }));
    setAttachments((current) => current.concat(onPrepareAttachments?.(next) ?? next));
  };

  const removeAttachment = (id: string) => {
    setAttachments((current) => {
      const removed = current.find((attachment) => attachment.id === id);
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return current.filter((attachment) => attachment.id !== id);
    });
    setAttachmentError(null);
  };

  const removeDocument = (id: string) => {
    const removed = documents.find((document) => document.id === id);
    setDocuments((current) => current.filter((document) => document.id !== id));
    if (removed) void onCancelDocumentPreparation(removed);
    setAttachmentError(null);
  };

  const documentStatus = (document: PendingChatDocument) => {
    switch (document.preparationStatus) {
      case "uploading":
        return "Uploading document…";
      case "parsing":
        return "Parsing document…";
      case "ready":
        return "Document ready";
      case "error":
        return document.preparationError || "The document could not be prepared.";
      default:
        return null;
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const images = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
    if (!images.length) return;
    event.preventDefault();
    addFiles(images);
  };

  return (
    <form
      className="composer-wrap"
      onSubmit={(event) => {
        if (startupPending) {
          event.preventDefault();
          return;
        }
        void onSubmit(event, attachments, documents);
      }}
    >
      <div className="composer">
        {editing && (
          <div className="composer-editing">
            <span>Editing prompt</span>
            <button type="button" onClick={onCancelEdit}>Cancel</button>
          </div>
        )}
        {attachments.length > 0 && (
          <div className="composer-attachments" aria-label="Attached images">
            {attachments.map((attachment) => (
              <div className="composer-attachment" key={attachment.id}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={attachment.previewUrl} alt="" />
                <span title={attachment.file.name}>{attachment.file.name || "Pasted image"}</span>
                <button
                  type="button"
                  aria-label={`Remove ${attachment.file.name || "pasted image"}`}
                  disabled={disabled}
                  onClick={() => removeAttachment(attachment.id)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {documents.length > 0 && (
          <div className="composer-attachments" aria-label="Attached documents">
            {documents.map((document) => {
              const status = documentStatus(document);
              const type = documentType(document.file.type, document.file.name);
              return (
                <div
                  className={`message-document-attachment message-document-attachment--${type.toLowerCase()} composer-document-attachment`}
                  key={document.id}
                  role="group"
                  aria-label={`${type} document: ${document.file.name}, ${formatDocumentSize(document.file.size)}`}
                >
                  <DocumentIcon type={type} />
                  <span className="message-document-details">
                    <span className="message-document-name" title={document.file.name}>{document.file.name}</span>
                    <span className="message-document-meta">
                      {type} <span aria-hidden="true">·</span> {formatDocumentSize(document.file.size)}
                    </span>
                    {status && (
                      <span
                        className={`composer-document-status ${document.preparationStatus === "error" ? "composer-document-status--error" : ""}`}
                        role={document.preparationStatus === "error" ? "alert" : "status"}
                      >
                        {status}
                      </span>
                    )}
                  </span>
                  <button
                    className="composer-document-remove"
                    type="button"
                    aria-label={`Remove ${document.file.name}`}
                    disabled={disabled}
                    onClick={() => removeDocument(document.id)}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        )}
        {preservedAttachments.length > 0 && (
          <div className="composer-attachments" aria-label="Attached images from the edited prompt">
            {preservedAttachments.map((image) => (
              <div className="composer-attachment" key={image.id}>
                <span title={image.name ?? "Attached image"}>{image.name || "Attached image"}</span>
                <button
                  type="button"
                  aria-label={`Remove ${image.name || "attached image"}`}
                  disabled={disabled}
                  onClick={() => onRemovePreservedAttachment?.(image.id)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {preservedDocuments.length > 0 && (
          <div className="composer-attachments" aria-label="Attached documents from the edited prompt">
            {preservedDocuments.map((document) => {
              const type = documentType(document.contentType, document.name);
              const pages = `${document.pageCount} ${document.pageCount === 1 ? "page" : "pages"}`;
              return (
                <div
                  className={`message-document-attachment message-document-attachment--${type.toLowerCase()} composer-document-attachment`}
                  key={document.id}
                  role="group"
                  aria-label={`${type} document: ${document.name}, ${formatDocumentSize(document.size)}, ${pages}`}
                >
                  <DocumentIcon type={type} />
                  <span className="message-document-details">
                    <span className="message-document-name" title={document.name}>{document.name}</span>
                    <span className="message-document-meta" aria-hidden="true">
                      {type} <span aria-hidden="true">·</span> {formatDocumentSize(document.size)} <span aria-hidden="true">·</span> {pages}
                    </span>
                  </span>
                  <button
                    className="composer-document-remove"
                    type="button"
                    aria-label={`Remove ${document.name}`}
                    disabled={disabled}
                    onClick={() => onRemovePreservedDocument?.(document.id)}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={draft}
          rows={1}
          aria-label="Message"
          placeholder="Message"
          disabled={isSubmittingAttachments}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && (attachments.length > 0 || documents.length > 0 || preservedAttachments.length > 0 || preservedDocuments.length > 0)) {
              event.preventDefault();
              if (!startupPending) void onSubmit(undefined, attachments, documents);
              return;
            }
            onKeyDown(event);
          }}
            onPaste={startupPending ? undefined : handlePaste}
        />
        <div className="composer-actions">
          <input
            ref={fileInputRef}
            className="composer-file-input"
            type="file"
            accept={`${ACCEPTED_CHAT_IMAGE_TYPES.join(",")},${DOCUMENT_CONTENT_TYPES.join(",")},.docx`}
            multiple
            tabIndex={-1}
            aria-hidden="true"
            onChange={(event) => {
              addFiles(Array.from(event.target.files ?? []));
              event.target.value = "";
            }}
          />
          <button
            type="button"
            className="attach-button"
            aria-label="Attach images, PDF, or DOCX"
            disabled={disabled}
            onClick={() => fileInputRef.current?.click()}
          >
            +
          </button>
          <div className="composer-action-spacer" />
          <div className="composer-menu">
            <button
              type="button"
              className="composer-menu-trigger"
              aria-label="Choose model"
              aria-controls="model-options"
              aria-expanded={openMenu === "model"}
              disabled={disabled || !models.length}
              onClick={() => setOpenMenu((current) => (current === "model" ? null : "model"))}
            >
              <span className="menu-trigger-label">{selectedModel?.label ?? "Model"}</span>
              <span className="menu-chevron" aria-hidden="true">⌄</span>
            </button>
            {openMenu === "model" && (
              <div
                id="model-options"
                className="composer-menu-popover"
                role="group"
                aria-label="Models"
              >
                {models.map((availableModel) => (
                  <button
                    key={availableModel.id}
                    type="button"
                    aria-pressed={availableModel.id === model}
                    className={`composer-menu-option ${availableModel.id === model ? "selected" : ""}`}
                    disabled={disabled}
                    onClick={() => {
                      setModel(availableModel.id);
                      const nextThinking = thinking && availableModel.thinkingSupported && Boolean(availableModel.supportedEfforts.length);
                      const nextEffort = availableModel.supportedEfforts.includes(effort)
                        ? effort
                        : (availableModel.supportedEfforts[0] ?? "high");
                      setThinking(nextThinking);
                      setEffort(nextEffort);
                      onPreferenceChange({ model: availableModel.id, thinking: nextThinking, reasoningEffort: nextEffort });
                      setOpenMenu(null);
                    }}
                  >
                    <span>{availableModel.label}</span>
                    {availableModel.id === model && <span aria-hidden="true">✓</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="composer-menu">
            <button
              type="button"
              className="composer-menu-trigger"
              aria-label="Choose thinking mode"
              aria-controls="thinking-options"
              aria-expanded={openMenu === "thinking"}
              disabled={disabled || !canThink}
              onClick={() => setOpenMenu((current) => (current === "thinking" ? null : "thinking"))}
            >
              <span className="menu-trigger-label">Thinking: {effectiveThinking ? effectiveEffort : "Off"}</span>
              <span className="menu-chevron" aria-hidden="true">⌄</span>
            </button>
            {openMenu === "thinking" && (
              <div
                id="thinking-options"
                className="composer-menu-popover"
                role="group"
                aria-label="Thinking mode"
              >
                <button
                  type="button"
                  aria-pressed={!thinking}
                  className={`composer-menu-option ${!thinking ? "selected" : ""}`}
                  disabled={disabled}
                  onClick={() => {
                    setThinking(false);
                    onPreferenceChange({ model, thinking: false, reasoningEffort: effort });
                    setOpenMenu(null);
                  }}
                >
                  <span>Off</span>
                  {!thinking && <span aria-hidden="true">✓</span>}
                </button>
                {supportedEfforts.map((supportedEffort) => (
                  <button
                    key={supportedEffort}
                    type="button"
                    aria-pressed={thinking && effort === supportedEffort}
                    className={`composer-menu-option ${thinking && effort === supportedEffort ? "selected" : ""}`}
                    disabled={isStreaming}
                    onClick={() => {
                      setThinking(true);
                      setEffort(supportedEffort);
                      onPreferenceChange({ model, thinking: true, reasoningEffort: supportedEffort });
                      setOpenMenu(null);
                    }}
                  >
                    <span>On · {supportedEffort[0].toUpperCase() + supportedEffort.slice(1)}</span>
                    {thinking && effort === supportedEffort && <span aria-hidden="true">✓</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
          {isStreaming ? (
            <button
              type="button"
              className="send-button stop-button"
              aria-label="Stop generating"
              onClick={onStop}
            >
              <svg className="stop-icon" viewBox="0 0 16 16" aria-hidden="true">
                <rect x="3" y="3" width="10" height="10" rx="1" />
              </svg>
            </button>
          ) : (
            <button
              type="submit"
              className="send-button"
              aria-label="Send message"
              disabled={disabled || (!draft.trim() && attachments.length === 0 && documents.length === 0 && preservedAttachments.length === 0 && preservedDocuments.length === 0)}
            >
              ↑
            </button>
          )}
        </div>
      </div>
      {(attachmentError || submissionError) && (
        <p className="composer-error" role="alert">{attachmentError || submissionError}</p>
      )}
      {startupPending && !attachmentError && !submissionError && (
        <p className="helper-text composer-startup-status" role="status">Restoring chat…</p>
      )}
      {isPreparingAttachments && documents.length === 0 && !attachmentError && !submissionError && (
        <p className="helper-text" role="status">Preparing image details…</p>
      )}
      <p className="helper-text">Press Enter to send · Shift + Enter for a new line</p>
    </form>
  );
}
