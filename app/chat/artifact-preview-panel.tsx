"use client";

import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ARTIFACT_PREVIEW_MIN_COLUMN_WIDTH,
  ARTIFACT_PREVIEW_RESIZE_STEP,
  clampArtifactPreviewWidth,
} from "./artifact-preview-layout";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export type ArtifactPreviewMode = "code" | "preview";

export type PreviewableArtifact = {
  id: string;
  name: string;
  content: string;
  contentType?: string;
  language?: string;
  preview?: "html" | "markdown" | "svg" | "image" | "text" | "none";
  workspacePath?: string;
  editable?: boolean;
};

export type ArtifactPreviewPanelProps<TArtifact extends PreviewableArtifact = PreviewableArtifact> = {
  artifact: TArtifact;
  width: number;
  onWidthChange: (width: number) => void;
  onChange: (content: string) => void;
  onSave: (artifact: TArtifact, content: string) => void | Promise<void>;
  onClose: () => void;
  loadState?: "ready" | "loading" | "error";
  errorMessage?: string;
  onRetry?: () => void;
  initialMode?: ArtifactPreviewMode;
  workspaceAssetBaseUrl?: string;
};

function Icon({ children }: { children: React.ReactNode }) {
  return <svg viewBox="0 0 20 20" aria-hidden="true">{children}</svg>;
}

function previewKind(artifact: PreviewableArtifact): "html" | "markdown" | "svg" | "image" | "text" {
  if (artifact.preview === "html" || artifact.preview === "markdown" || artifact.preview === "svg" || artifact.preview === "image" || artifact.preview === "text") return artifact.preview;
  const contentType = artifact.contentType?.split(";", 1)[0].trim().toLowerCase();
  if (contentType === "text/html") return "html";
  if (contentType === "text/markdown") return "markdown";
  if (contentType === "image/svg+xml") return "svg";
  if (contentType?.startsWith("image/")) return "image";
  return "text";
}

function encodeWorkspacePath(path: string): string {
  return path.split("/").filter(Boolean).map((segment) => encodeURIComponent(segment)).join("/");
}

function workspaceAssetUrl(baseUrl: string | undefined, path: string | undefined): string | undefined {
  if (!baseUrl || !path) return undefined;
  return `${baseUrl.replace(/\/+$/u, "")}/${encodeWorkspacePath(path)}`;
}

function workspaceAssetDirectoryUrl(baseUrl: string | undefined, path: string | undefined): string | undefined {
  if (!baseUrl || !path) return undefined;
  const directory = path.slice(0, Math.max(0, path.lastIndexOf("/") + 1));
  return `${baseUrl.replace(/\/+$/u, "")}/${encodeWorkspacePath(directory)}`;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function sandboxDocument(content: string, kind: "html" | "svg", baseHref?: string): string {
  const body = kind === "svg"
    ? `<div style="display:grid;place-items:center;min-height:100vh">${content}</div>`
    : content;
  const base = baseHref ? `<base href="${escapeAttribute(baseHref)}">` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; frame-src 'self'; connect-src 'none'; object-src 'none'; form-action 'none'; frame-ancestors 'self';">${base}<style>html,body{margin:0;min-height:100%;background:#fff}body{font-family:system-ui,sans-serif}</style></head><body>${body}</body></html>`;
}

export function ArtifactPreviewPanel<TArtifact extends PreviewableArtifact>({
  artifact,
  width,
  onWidthChange,
  onChange,
  onSave,
  onClose,
  loadState = "ready",
  errorMessage = "This artifact could not be loaded.",
  onRetry,
  initialMode = "code",
  workspaceAssetBaseUrl,
}: ArtifactPreviewPanelProps<TArtifact>) {
  const [mode, setMode] = useState<ArtifactPreviewMode>(initialMode);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const resizeForPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    onWidthChange(clampArtifactPreviewWidth(
      drag.current.startWidth + drag.current.startX - event.clientX,
      window.innerWidth,
    ));
  };

  const save = async () => {
    if (saveState === "saving" || loadState !== "ready") return;
    setCopyState("idle");
    setSaveState("saving");
    try {
      await onSave(artifact, artifact.content);
      setSaveState("saved");
    } catch {
      setSaveState("error");
    }
  };

  const copy = async () => {
    setSaveState("idle");
    try {
      await navigator.clipboard.writeText(artifact.content);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob(
      [artifact.content],
      { type: artifact.contentType || "text/plain;charset=utf-8" },
    ));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = artifact.name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  const disabled = loadState !== "ready";
  const editable = artifact.editable !== false && Boolean(artifact.workspacePath);
  const kind = previewKind(artifact);
  const assetUrl = workspaceAssetUrl(workspaceAssetBaseUrl, artifact.workspacePath);
  const assetDirectoryUrl = workspaceAssetDirectoryUrl(workspaceAssetBaseUrl, artifact.workspacePath);

  return (
    <aside
      className="artifact-preview-panel artifact-preview-fullscreen-compatible"
      aria-label={`${artifact.name} artifact editor`}
      style={{ width }}
    >
      <div
        className="artifact-preview-resizer"
        role="separator"
        aria-label="Resize artifact preview"
        aria-orientation="vertical"
        aria-valuemin={ARTIFACT_PREVIEW_MIN_COLUMN_WIDTH}
        aria-valuenow={Math.round(width)}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          const delta = event.key === "ArrowLeft"
            ? ARTIFACT_PREVIEW_RESIZE_STEP
            : -ARTIFACT_PREVIEW_RESIZE_STEP;
          onWidthChange(clampArtifactPreviewWidth(width + delta, window.innerWidth));
        }}
        onPointerDown={(event) => {
          drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={resizeForPointer}
        onPointerUp={(event) => {
          resizeForPointer(event);
          drag.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => { drag.current = null; }}
      />

      <header className="artifact-preview-header">
        <div className="artifact-preview-heading">
          <h2 title={artifact.name}>{artifact.name}</h2>
          {artifact.language && <span>{artifact.language}</span>}
        </div>
        <div className="artifact-preview-actions">
          <button type="button" onClick={() => void save()} disabled={disabled || !editable || saveState === "saving"} aria-label={`Save ${artifact.name}`} title="Save">
            <Icon><path d="M4 3.5h10l2 2v11H4zM7 3.5v5h6v-5M7 16.5v-5h6v5" /></Icon>
          </button>
          <button type="button" onClick={() => void copy()} disabled={disabled} aria-label={`Copy ${artifact.name}`} title="Copy">
            <Icon><rect x="6.5" y="6.5" width="9" height="10" rx="1.5" /><path d="M13.5 6.5v-3h-9v10h2" /></Icon>
          </button>
          <button type="button" onClick={download} disabled={disabled} aria-label={`Download ${artifact.name}`} title="Download">
            <Icon><path d="M10 2.5v10m0 0 4-4m-4 4-4-4M3.5 16.5h13" /></Icon>
          </button>
          <button type="button" onClick={onClose} aria-label="Close artifact preview" title="Close">
            <Icon><path d="m4.5 4.5 11 11m0-11-11 11" /></Icon>
          </button>
        </div>
      </header>

      <div className="artifact-preview-toolbar">
        <div className="artifact-preview-tabs" role="tablist" aria-label="Artifact view">
          {(["code", "preview"] as const).map((nextMode) => (
            <button
              key={nextMode}
              type="button"
              role="tab"
              aria-selected={mode === nextMode}
              onClick={() => setMode(nextMode)}
            >
              {nextMode === "code" ? "Code" : "Preview"}
            </button>
          ))}
        </div>
        <div className="artifact-preview-feedback" aria-live="polite">
          {saveState === "saving" && "Saving…"}
          {saveState === "saved" && "Saved"}
          {saveState === "error" && "Save failed"}
          {copyState === "copied" && "Copied"}
          {copyState === "error" && "Copy failed"}
        </div>
      </div>

      <div className="artifact-preview-body">
        {loadState === "loading" && <div className="artifact-preview-status" role="status">Loading artifact…</div>}
        {loadState === "error" && (
          <div className="artifact-preview-status artifact-preview-error" role="alert">
            <p>{errorMessage}</p>
            {onRetry && <button type="button" onClick={onRetry}>Try again</button>}
          </div>
        )}
        {loadState === "ready" && mode === "code" && (
          <textarea
            className="artifact-preview-editor"
            aria-label={`Edit ${artifact.name}`}
            value={artifact.content}
            readOnly={!editable}
            onChange={(event) => {
              setSaveState("idle");
              setCopyState("idle");
              onChange(event.target.value);
            }}
            spellCheck={false}
          />
        )}
        {loadState === "ready" && mode === "preview" && (kind === "html" || kind === "svg") && (
          <iframe
            className="artifact-preview-frame"
            title={`${artifact.name} preview`}
            sandbox="allow-scripts"
            srcDoc={sandboxDocument(artifact.content, kind, assetDirectoryUrl)}
          />
        )}
        {loadState === "ready" && mode === "preview" && kind === "image" && assetUrl && (
          <div className="artifact-preview-image">
            {/* Private workspace assets require the browser's session cookie and cannot use next/image optimization. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={assetUrl} alt={artifact.name} />
          </div>
        )}
        {loadState === "ready" && mode === "preview" && kind === "image" && !assetUrl && (
          <div className="artifact-preview-status" role="alert">This image is not backed by a workspace file.</div>
        )}
        {loadState === "ready" && mode === "preview" && kind === "markdown" && (
          <div className="artifact-preview-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{artifact.content}</ReactMarkdown></div>
        )}
        {loadState === "ready" && mode === "preview" && kind === "text" && (
          <pre className="artifact-preview-text"><code>{artifact.content}</code></pre>
        )}
      </div>
    </aside>
  );
}
