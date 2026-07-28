"use client";

import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import type { ChatArtifact } from "../../lib/chat-protocol";
import {
  PDF_PREVIEW_MIN_COLUMN_WIDTH,
  PDF_PREVIEW_RESIZE_STEP,
  clampPdfPreviewWidth,
} from "./pdf-preview-layout";

export type PdfPreviewLoadState =
  | { status: "loading" }
  | { status: "loaded"; blob: Blob; url: string }
  | { status: "error"; message: string };

export function PdfPreviewPanel({
  artifact,
  loadState,
  width,
  onWidthChange,
  onRetry,
  onClose,
}: {
  artifact: ChatArtifact;
  loadState: PdfPreviewLoadState;
  width: number;
  onWidthChange: (width: number) => void;
  onRetry: () => void;
  onClose: () => void;
}) {
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
    onWidthChange(clampPdfPreviewWidth(
      drag.current.startWidth + drag.current.startX - event.clientX,
      window.innerWidth,
    ));
  };

  const download = () => {
    if (loadState.status !== "loaded") return;
    const anchor = document.createElement("a");
    anchor.href = loadState.url;
    anchor.download = artifact.name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  };

  return (
    <aside
      className="pdf-preview-panel"
      aria-label={`${artifact.name} PDF preview`}
      style={{ width }}
    >
      <div
        className="pdf-preview-resizer"
        role="separator"
        aria-label="Resize PDF preview"
        aria-orientation="vertical"
        aria-valuemin={PDF_PREVIEW_MIN_COLUMN_WIDTH}
        aria-valuenow={Math.round(width)}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          const delta = event.key === "ArrowLeft"
            ? PDF_PREVIEW_RESIZE_STEP
            : -PDF_PREVIEW_RESIZE_STEP;
          onWidthChange(clampPdfPreviewWidth(width + delta, window.innerWidth));
        }}
        onPointerDown={(event) => {
          drag.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startWidth: width,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={resizeForPointer}
        onPointerUp={(event) => {
          resizeForPointer(event);
          drag.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      />
      <header className="pdf-preview-header">
        <h2 title={artifact.name}>{artifact.name}</h2>
        <div className="pdf-preview-actions">
          <button
            type="button"
            onClick={download}
            disabled={loadState.status !== "loaded"}
            aria-label={`Download ${artifact.name}`}
            title="Download"
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M10 2.5v10m0 0 4-4m-4 4-4-4M3.5 16.5h13" />
            </svg>
          </button>
          <button type="button" onClick={onClose} aria-label="Close PDF preview" title="Close">
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="m4.5 4.5 11 11m0-11-11 11" />
            </svg>
          </button>
        </div>
      </header>
      <div className="pdf-preview-body">
        {loadState.status === "loading" && (
          <div className="pdf-preview-status" role="status">Loading PDF…</div>
        )}
        {loadState.status === "error" && (
          <div className="pdf-preview-status pdf-preview-error" role="alert">
            <p>{loadState.message}</p>
            <button type="button" onClick={onRetry}>Try again</button>
          </div>
        )}
        {loadState.status === "loaded" && (
          <iframe src={loadState.url} title={`${artifact.name} PDF`} />
        )}
      </div>
    </aside>
  );
}
