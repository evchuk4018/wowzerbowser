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
import { chatModelIdentity, type ChatModelRef, type ChatModelInfo, type ChatReasoningEffort } from "../../lib/chat-model-protocol";
import type { ChatImageAttachment } from "../../lib/chat-image";
import type { ChatModelPreference } from "../../lib/chat-model-preference";
import {
  ACCEPTED_CHAT_IMAGE_TYPES,
  type PendingChatImage,
  validateChatImages,
} from "./chat-image-attachments";
import { validateChatDocument, type PendingChatDocument } from "./chat-document-attachments";
import { DOCUMENT_CONTENT_TYPES, type ChatDocumentAttachment } from "../../lib/chat-document";
import type { TodoList } from "../../lib/todo-protocol";
import { CHAT_MODE_COMMANDS, chatModeCommandAtCaret, clearChatModeCommand, type ChatMode } from "../../lib/chat-modes";
import { filterChatComposerCommands, moveChatCommandIndex, removeChatCommandToken, CHAT_PROJECT_COMMAND as PROJECT_COMMAND } from "../../lib/chat-command-picker";
import type { ChatProject } from "../../lib/chat-project-protocol";
import { appendChatVoiceTranscript, MAX_CHAT_VOICE_DURATION_MS } from "../../lib/chat-voice";
import { transcribeChatVoice } from "./chat-service";
import {
  convertRecordedAudioToWav,
  startVoiceRecording as beginVoiceRecording,
  type VoiceRecordingSession,
} from "./chat-voice-recorder";
import { DocumentIcon, FolderIcon, REASONING_LABELS, documentType, formatDocumentSize } from "./chat-composer-parts";

type CommandView = "commands" | "projects";
type VoiceState = "idle" | "recording" | "transcribing";

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
  projects: readonly ChatProject[];
  projectsLoading: boolean;
  projectsError: string | null;
  onLoadProjects: () => void | Promise<void>;
  currentProjectId: string | null;
  assigningProjectId: string | null;
  projectAssignmentStatus: string | null;
  projectAssignmentError: string | null;
  onAssignProject: (project: ChatProject) => void | Promise<void>;
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
  projects,
  projectsLoading,
  projectsError,
  onLoadProjects,
  currentProjectId,
  assigningProjectId,
  projectAssignmentStatus,
  projectAssignmentError,
  onAssignProject,
}: ChatComposerProps) {
  const [attachments, setAttachments] = useState<PendingChatImage[]>([]);
  const [documents, setDocuments] = useState<PendingChatDocument[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [expanded, setExpanded] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachmentsRef = useRef(attachments);
  const documentsRef = useRef(documents);
  const voiceSessionRef = useRef<VoiceRecordingSession | null>(null);
  const voiceTimerRef = useRef<number | null>(null);
  const voiceRequestControllerRef = useRef<AbortController | null>(null);
  const disabled = isStreaming || isSubmittingAttachments || startupPending;
  const [commandMenuOpen, setCommandMenuOpen] = useState(false);
  const [commandToken, setCommandToken] = useState<{ start: number; end: number; query: string } | null>(null);
  const [commandView, setCommandView] = useState<CommandView>("commands");
  const [commandIndex, setCommandIndex] = useState(0);
  const [projectIndex, setProjectIndex] = useState(0);
  const composerDisabled = disabled || voiceState !== "idle";
  const projectPickerDisabled = composerDisabled || isPreparingAttachments || Boolean(assigningProjectId);
  const matchingCommands = filterChatComposerCommands(commandToken?.query ?? "");
  const activeCommandIndex = Math.min(commandIndex, Math.max(0, matchingCommands.length - 1));
  const activeProjectIndex = Math.min(projectIndex, Math.max(0, projects.length - 1));

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

  useEffect(() => () => {
    if (voiceTimerRef.current !== null) window.clearTimeout(voiceTimerRef.current);
    voiceRequestControllerRef.current?.abort();
    voiceSessionRef.current?.cancel();
  }, []);

  const stopVoiceInput = async () => {
    const session = voiceSessionRef.current;
    if (!session) return;
    voiceSessionRef.current = null;
    if (voiceTimerRef.current !== null) {
      window.clearTimeout(voiceTimerRef.current);
      voiceTimerRef.current = null;
    }
    setVoiceState("transcribing");
    try {
      const recording = await session.stop();
      const wav = await convertRecordedAudioToWav(recording);
      const controller = new AbortController();
      voiceRequestControllerRef.current = controller;
      const answer = await transcribeChatVoice(wav, controller.signal);
      setDraft((current) => appendChatVoiceTranscript(current, answer.transcript));
      setVoiceError(null);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setVoiceError(error instanceof Error ? error.message : "The voice recording could not be transcribed.");
      }
    } finally {
      voiceRequestControllerRef.current = null;
      setVoiceState("idle");
    }
  };

  const startVoiceInput = async () => {
    if (composerDisabled) return;
    setVoiceError(null);
    try {
      const session = await beginVoiceRecording();
      if (disabled) {
        session.cancel();
        return;
      }
      voiceSessionRef.current = session;
      setVoiceState("recording");
      voiceTimerRef.current = window.setTimeout(() => {
        void stopVoiceInput();
      }, MAX_CHAT_VOICE_DURATION_MS);
    } catch (error) {
      setVoiceState("idle");
      setVoiceError(error instanceof Error ? error.message : "Microphone access was unavailable.");
    }
  };

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

  const selectModeCommand = (item: (typeof CHAT_MODE_COMMANDS)[number]) => {
    setMode(item.mode);
    if (!commandToken) return;
    const nextDraft = `${draft.slice(0, commandToken.start)}${item.command} ${draft.slice(commandToken.end)}`;
    setDraft(nextDraft);
    setCommandToken(null);
    setCommandMenuOpen(false);
    setCommandView("commands");
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      const caret = commandToken.start + item.command.length + 1;
      textarea.focus();
      textarea.setSelectionRange(caret, caret);
    });
  };

  const enterProjectsView = () => {
    if (projectPickerDisabled) return;
    setCommandView("projects");
    setProjectIndex(0);
    void onLoadProjects();
  };

  const removeProjectCommandToken = (token: { start: number; end: number }) => {
    const nextDraft = removeChatCommandToken(draft, token);
    setDraft(nextDraft);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(token.start, token.start);
    });
  };

  const selectProject = async (project: ChatProject) => {
    if (projectPickerDisabled || !commandToken) return;
    const token = commandToken;
    setCommandToken(null);
    setCommandMenuOpen(false);
    setCommandView("commands");
    removeProjectCommandToken(token);
    try {
      await onAssignProject(project);
    } catch {
      // The workspace owns assignment errors. Keep the composer usable if a
      // caller rejects without presenting its own error state.
    }
  };

  const handleCommandMenuKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!commandMenuOpen || !commandToken || projectPickerDisabled) return false;
    const itemCount = commandView === "projects" ? projects.length : matchingCommands.length;
    if (event.key === "ArrowDown" && itemCount > 0) {
      event.preventDefault();
      if (commandView === "projects") setProjectIndex((current) => moveChatCommandIndex(current, 1, itemCount));
      else setCommandIndex((current) => moveChatCommandIndex(current, 1, itemCount));
      return true;
    }
    if (event.key === "ArrowUp" && itemCount > 0) {
      event.preventDefault();
      if (commandView === "projects") setProjectIndex((current) => moveChatCommandIndex(current, -1, itemCount));
      else setCommandIndex((current) => moveChatCommandIndex(current, -1, itemCount));
      return true;
    }
    if (event.key === "Home" && itemCount > 0) {
      event.preventDefault();
      if (commandView === "projects") setProjectIndex(0);
      else setCommandIndex(0);
      return true;
    }
    if (event.key === "End" && itemCount > 0) {
      event.preventDefault();
      if (commandView === "projects") setProjectIndex(itemCount - 1);
      else setCommandIndex(itemCount - 1);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (commandView === "projects") {
        setCommandView("commands");
        setCommandIndex(0);
      } else {
        setCommandMenuOpen(false);
        setCommandToken(null);
      }
      return true;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (commandView === "projects") {
        const project = projects[activeProjectIndex];
        if (project) void selectProject(project);
      } else {
        const item = matchingCommands[activeCommandIndex];
        if (!item) return true;
        if (item.command === PROJECT_COMMAND.command) enterProjectsView();
        else if ("mode" in item) selectModeCommand(item);
      }
      return true;
    }
    return false;
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
                  disabled={composerDisabled}
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
                    disabled={composerDisabled}
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
                  disabled={composerDisabled}
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
                    disabled={composerDisabled}
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
            setCommandView("commands");
            setCommandIndex(0);
          }}
          onKeyDown={(event) => {
            if (handleCommandMenuKeyDown(event)) return;
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
            disabled={composerDisabled}
            onClick={() => fileInputRef.current?.click()}
          >
            +
          </button>
          {commandMenuOpen && commandToken && !projectPickerDisabled && (
            <div
              className="composer-command-popover"
              role="listbox"
              aria-label={commandView === "projects" ? "Projects" : "Commands"}
              onKeyDown={(event) => { handleCommandMenuKeyDown(event); }}
            >
              {commandView === "commands" && <>
              <div className="composer-command-heading">Commands</div>
              {matchingCommands.filter((item) => "mode" in item).map((item, index) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={index === activeCommandIndex}
                  className={`composer-command-option ${index === activeCommandIndex || mode === item.mode ? "selected" : ""}`}
                  key={item.command}
                  onMouseEnter={() => setCommandIndex(index)}
                  onClick={() => selectModeCommand(item)}
                >
                  <span className="composer-command-icon" aria-hidden="true">⌁</span>
                  <span><strong>{item.label}</strong><small>{item.description}</small></span>
                </button>
              ))}
              {matchingCommands.some((item) => item.command === PROJECT_COMMAND.command) && (
                <button
                  type="button"
                  role="option"
                  aria-selected={matchingCommands.findIndex((item) => item.command === PROJECT_COMMAND.command) === activeCommandIndex}
                  className={`composer-command-option ${matchingCommands.findIndex((item) => item.command === PROJECT_COMMAND.command) === activeCommandIndex ? "selected" : ""}`}
                  onMouseEnter={() => setCommandIndex(matchingCommands.findIndex((item) => item.command === PROJECT_COMMAND.command))}
                  onClick={enterProjectsView}
                >
                  <span className="composer-command-icon" aria-hidden="true"><FolderIcon /></span>
                  <span><strong>{PROJECT_COMMAND.label}</strong><small>{PROJECT_COMMAND.description}</small></span>
                </button>
              )}
              </>}
              {commandView === "projects" && (
                <>
                  <div className="composer-command-heading composer-command-heading--projects">
                    <button
                      type="button"
                      className="composer-command-back"
                      onKeyDown={(event) => event.stopPropagation()}
                      onClick={() => {
                        setCommandView("commands");
                        setCommandIndex(0);
                      }}
                    >
                      <span aria-hidden="true">←</span> Commands
                    </button>
                    <span>Projects</span>
                  </div>
                  {projectsLoading && <div className="composer-command-state" role="status">Loading projects…</div>}
                  {!projectsLoading && projectsError && (
                    <div className="composer-command-state composer-command-state--error" role="alert">
                      <span>{projectsError}</span>
                      <button type="button" onKeyDown={(event) => event.stopPropagation()} onClick={() => void onLoadProjects()}>Retry</button>
                    </div>
                  )}
                  {!projectsLoading && !projectsError && projects.length === 0 && (
                    <div className="composer-command-state">No projects yet</div>
                  )}
                  {!projectsLoading && !projectsError && projects.map((project, index) => {
                    const selected = index === activeProjectIndex;
                    const current = project.id === currentProjectId;
                    return (
                      <button
                        type="button"
                        role="option"
                        aria-selected={selected}
                        className={`composer-command-option composer-project-option ${selected ? "selected" : ""}`}
                        key={project.id}
                        disabled={composerDisabled || Boolean(assigningProjectId)}
                        onMouseEnter={() => setProjectIndex(index)}
                        onClick={() => void selectProject(project)}
                      >
                        <span className="composer-command-icon" aria-hidden="true"><FolderIcon /></span>
                        <span className="composer-project-option-text"><strong>{project.title}</strong><small>{current ? "Current project" : "Add this chat here"}</small></span>
                        {current && <span className="composer-project-current" aria-label="Current project">✓</span>}
                      </button>
                    );
                  })}
                </>
              )}
            </div>
          )}
          {mode === "deep_research" && (
            <button
              type="button"
              className="composer-mode-chip"
              aria-label="Disable deep research"
              aria-pressed={true}
              disabled={composerDisabled}
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
              disabled={composerDisabled || !models.length}
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
                    disabled={composerDisabled}
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
              disabled={composerDisabled || !canThink}
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
                  disabled={composerDisabled}
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
                    disabled={composerDisabled}
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
          <button
            type="button"
            className={`voice-button ${voiceState === "recording" ? "voice-button--recording" : ""}`}
            aria-label={voiceState === "recording" ? "Stop recording" : voiceState === "transcribing" ? "Transcribing voice" : "Record voice message"}
            aria-pressed={voiceState === "recording"}
            disabled={disabled || voiceState === "transcribing"}
            onClick={() => {
              if (voiceState === "recording") void stopVoiceInput();
              else void startVoiceInput();
            }}
          >
            {voiceState === "recording" ? (
              <svg className="voice-stop-icon" viewBox="0 0 16 16" aria-hidden="true">
                <rect x="4" y="4" width="8" height="8" rx="1" />
              </svg>
            ) : (
              <svg className="voice-icon" viewBox="0 0 16 16" aria-hidden="true">
                <rect x="5" y="2" width="6" height="8" rx="3" />
                <path d="M3 8a5 5 0 0 0 10 0M8 13v2M5.5 15h5" />
              </svg>
            )}
          </button>
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
              disabled={composerDisabled || (!draft.trim() && attachments.length === 0 && documents.length === 0 && preservedAttachments.length === 0 && preservedDocuments.length === 0)}
            >
              <svg className="send-icon" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M8 13V3" />
                <path d="m4.5 6.5 3.5-3.5 3.5 3.5" />
              </svg>
            </button>
          )}
        </div>
      </div>
      {(attachmentError || voiceError || submissionError) && (
        <p className="composer-error" role="alert">{attachmentError || voiceError || submissionError}</p>
      )}
      {projectAssignmentError && <p className="composer-error" role="alert">{projectAssignmentError}</p>}
      {projectAssignmentStatus && <p className="helper-text composer-project-status" role="status" aria-live="polite">{projectAssignmentStatus}</p>}
      {startupPending && !attachmentError && !voiceError && !submissionError && (
        <p className="helper-text composer-startup-status" role="status">Restoring chat…</p>
      )}
      {voiceState === "recording" && <p className="helper-text" role="status">Recording voice...</p>}
      {voiceState === "transcribing" && <p className="helper-text" role="status">Transcribing voice...</p>}
      {isPreparingAttachments && documents.length === 0 && !attachmentError && !voiceError && !submissionError && (
        <p className="helper-text" role="status">Preparing image details…</p>
      )}
      <p className="helper-text">Press Enter to send · Shift + Enter for a new line</p>
    </form>
  );
}
