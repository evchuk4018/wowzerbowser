import type { ChatReasoningEffort } from "../../lib/chat-model-protocol";
import { DOCX_CONTENT_TYPE } from "../../lib/chat-document";

export const REASONING_LABELS: Record<ChatReasoningEffort, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

export function formatDocumentSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function documentType(contentType: string, name: string): "PDF" | "DOCX" {
  if (contentType === "application/pdf") return "PDF";
  if (contentType === DOCX_CONTENT_TYPE) return "DOCX";
  return name.toLowerCase().endsWith(".pdf") ? "PDF" : "DOCX";
}

export function FolderIcon() {
  return (
    <svg className="composer-folder-icon" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M2.5 5.5h5l1.6 2h8.4v7.2a1.8 1.8 0 0 1-1.8 1.8H4.3a1.8 1.8 0 0 1-1.8-1.8V5.5Z" />
      <path d="M2.5 7.5h15" />
    </svg>
  );
}

export function DocumentIcon({ type }: { type: "PDF" | "DOCX" }) {
  return (
    <span className="message-document-icon" aria-hidden="true">
      <span className="message-document-icon-fold" />
      <span className="message-document-type">{type}</span>
    </span>
  );
}
