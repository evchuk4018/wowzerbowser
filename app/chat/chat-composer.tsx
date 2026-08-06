"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type Dispatch,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
  type SetStateAction,
} from "react";
import { chatModelIdentity, type ChatImageAttachment, type ChatModelRef, type ChatModelInfo, type ChatReasoningEffort } from "../../lib/chat-protocol";
import type { ChatModelPreference } from "../../lib/chat-model-preference";
import {
  ACCEPTED_CHAT_IMAGE_TYPES,
  type PendingChatImage,
  validateChatImages,
} from "./chat-image-attachments";
import { validateChatDocument, type PendingChatDocument } from "./chat-document-attachments";
import { DOCX_CONTENT_TYPE, DOCUMENT_CONTENT_TYPES, type ChatDocumentAttachment } from "../../lib/chat-document";
import type { TodoList } from "../../lib/todo-protocol";
import { CHAT_MODE_COMMANDS, chatModeCommandAtCaret, clearChatModeCommand, type ChatMode } from "../../lib/chat-modes";

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

const REASONING_LABELS: Record<ChatReasoningEffort, string> = {
  minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra High", max: "Max",
};

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
  model: ChatModelRef;
  setModel: Dispatch<SetStateAction<ChatModelRef>>;
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
  todos?: TodoList;
  mode: ChatMode;
  setMode: Dispatch<SetStateAction<ChatMode>>;
};

function TodoBar({ todos }: { todos?: TodoList }) {
  const [expanded, setExpanded] = useState(false);
  if (!todos?.items.length) return null;
  const active = todos.items.filter((item) => item.status !== "completed");
  const top = active[0] ?? todos.items.at(-1)!;
  const completed = todos.items.length - active.length;
  return (
    <div className={`composer-todos ${expanded ? "composer-todos--expanded" : ""}`}>
      <button type="button" className="composer-todos-trigger" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
        <span className="composer-todos-label">Todo {completed}/{todos.items.length}</span>
        <span className="composer-todos-top" title={top.text}>{top.text}</span>
        <span aria-hidden="true">{expanded ? "⌃" : "⌄"}</span>
      </button>
      {expanded && <ol className="composer-todos-list">
        {todos.items.map((item) => <li key={item.id} className={item.status === "completed" ? "is-complete" : ""}><span aria-hidden="true">{item.status === "completed" ? "✓" : "○"}</span>{item.text}</li>)}
      </ol>}
    </div>
  );
}

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
  todos,
  mode,
  setMode,
}: ChatComposerProps) {
  const [attachments, setAttachments] = useState<PendingChatImage[]>([]);
  const [documents, setDocuments] = useState<PendingChatDocument[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachmentsRef = useRef(attachments);
  const documentsRef = useRef(documents);
  const disabled = isStreaming || isSubmittingAttachments || startupPending;
  const [commandMenuOpen, setCommandMenuOpen] = useState(false);
  const [commandToken, setCommandToken] = useState<{ start: number; end: number; query: string } | null>(null);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const lineHeight = Number.parseFloat(window.getComputedStyle(textarea).lineHeight) || 24;
    const minHeight = lineHeight * 2;
    const maxHeight = lineHeight * 8;
    textarea.style.height = "auto";
    const height = Math.max(minHeight, Math.min(textarea.scrollHeight, maxHeight));
    textarea.style.height = `${height}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [draft, expanded, textareaRef]);

  useEffect(() => {
    if (!expanded) return;
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [expanded, textareaRef]);

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

  const closeExpandedEditor = () => setExpanded(false);
  const submitAndClose = (event?: FormEvent<HTMLFormElement>, pendingAttachments?: readonly PendingChatImage[], pendingDocuments?: readonly PendingChatDocument[]) => {
    closeExpandedEditor();
    return onSubmit(event, pendingAttachments, pendingDocuments);
  };

  return (
    <form
      className={`composer-wrap ${expanded ? "composer-wrap--expanded" : ""}`}
      onSubmit={(event) => {
        if (startupPending) {
          event.preventDefault();
          return;
        }
        void submitAndClose(event, attachments, documents);
      }}
    >
      <div className={`composer ${expanded ? "composer--expanded" : ""}`}>
        <button
          type="button"
          className="composer-expand-button"
          aria-label={expanded ? "Close expanded editor" : "Expand message editor"}
          onClick={() => setExpanded((current) => !current)}
        >
          <svg className="composer-expand-icon" viewBox="0 0 16 16" aria-hidden="true">
            {expanded ? (
              <>
                <path d="M12 4 4 12" />
                <path d="M10 12H4V6" />
              </>
            ) : (
              <>
                <path d="M4 12 12 4" />
                <path d="M6 4h6v6" />
              </>
            )}
          </svg>
        </button>
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
        <TodoBar todos={todos} />
        <textarea
          ref={textareaRef}
          value={draft}
          rows={1}
          aria-label="Message"
          placeholder="Message"
          disabled={isSubmittingAttachments}
          onChange={(event) => {
            const next = event.target.value;
            setDraft(next);
            const token = chatModeCommandAtCaret(next, event.target.selectionStart);
            setCommandToken(token);
            setCommandMenuOpen(Boolean(token));
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && expanded) {
              event.preventDefault();
              closeExpandedEditor();
              return;
            }
            if (event.key === "Enter" && !event.shiftKey && (attachments.length > 0 || documents.length > 0 || preservedAttachments.length > 0 || preservedDocuments.length > 0)) {
              event.preventDefault();
              if (!startupPending) void submitAndClose(undefined, attachments, documents);
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
          {commandMenuOpen && commandToken && !disabled && (
            <div className="composer-command-popover" role="listbox" aria-label="Commands">
              <div className="composer-command-heading">Commands</div>
              {CHAT_MODE_COMMANDS.filter((item) => item.command.startsWith(commandToken.query)).map((item) => (
                <button
                  type="button"
                  className={`composer-command-option ${mode === item.mode ? "selected" : ""}`}
                  key={item.command}
                  onClick={() => {
                    setMode(item.mode);
                    const nextDraft = `${draft.slice(0, commandToken.start)}${item.command} ${draft.slice(commandToken.end)}`;
                    setDraft(nextDraft);
                    setCommandToken(null);
                    setCommandMenuOpen(false);
                    requestAnimationFrame(() => {
                      const textarea = textareaRef.current;
                      if (!textarea) return;
                      textarea.focus();
                      const caret = commandToken.start + item.command.length + 1;
                      textarea.setSelectionRange(caret, caret);
                    });
                  }}
                >
                  <span className="composer-command-icon" aria-hidden="true">⌁</span>
                  <span><strong>{item.label}</strong><small>{item.description}</small></span>
                </button>
              ))}
            </div>
          )}
          {mode === "deep_research" && (
            <button
              type="button"
              className="composer-mode-chip"
              aria-label="Disable deep research"
              aria-pressed={true}
              disabled={disabled}
              onClick={() => {
                setMode("normal");
                setDraft((current) => clearChatModeCommand(current));
              }}
            >
              Deep research
            </button>
          )}
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
              <span className="menu-trigger-label">{selectedModel?.displayName ?? "Model"}</span>
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
                    key={chatModelIdentity(availableModel.ref)}
                    type="button"
                    aria-pressed={chatModelIdentity(availableModel.ref) === chatModelIdentity(model)}
                    className={`composer-menu-option ${chatModelIdentity(availableModel.ref) === chatModelIdentity(model) ? "selected" : ""}`}
                    disabled={disabled}
                    onClick={() => {
                      setModel(availableModel.ref);
                      const nextThinking = availableModel.reasoningRequired || (thinking && Boolean(availableModel.supportedEfforts.length));
                      const nextEffort = availableModel.supportedEfforts.includes(effort)
                        ? effort
                        : (availableModel.supportedEfforts[0] ?? "high");
                      setThinking(nextThinking);
                      setEffort(nextEffort);
                      onPreferenceChange({ model: availableModel.ref, thinking: nextThinking, reasoningEffort: nextEffort });
                      setOpenMenu(null);
                    }}
                  >
                    <span>{availableModel.displayName}</span>
                    {chatModelIdentity(availableModel.ref) === chatModelIdentity(model) && <span aria-hidden="true">✓</span>}
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
                {!selectedModel?.reasoningRequired && <button
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
                </button>}
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
                    <span>{REASONING_LABELS[supportedEffort]}</span>
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
              <svg className="send-icon" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M8 13V3" />
                <path d="m4.5 6.5 3.5-3.5 3.5 3.5" />
              </svg>
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
