"use client";

import { useEffect, useState } from "react";
import type { ChatArtifact } from "../../lib/chat-protocol";
import { fetchChatArtifact } from "./chat-service";

type ArtifactPreviewProps = {
  artifact: ChatArtifact | null;
  getAccessToken: () => Promise<string | null>;
  onClose: () => void;
};

type PreviewState =
  | { status: "loading"; artifactId: string | null }
  | { status: "ready"; artifactId: string; blob: Blob; url: string }
  | { status: "error"; artifactId: string; message: string };

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ArtifactPreview({ artifact, getAccessToken, onClose }: ArtifactPreviewProps) {
  const [state, setState] = useState<PreviewState>({ status: "loading", artifactId: null });
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    if (!artifact) return;
    let active = true;
    let objectUrl: string | null = null;

    void getAccessToken()
      .then((accessToken) => {
        if (!accessToken) throw new Error("Your session expired. Sign in again to view this file.");
        return fetchChatArtifact(artifact, accessToken);
      })
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ status: "ready", artifactId: artifact.id, blob, url: objectUrl });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setState({
          status: "error",
          artifactId: artifact.id,
          message: error instanceof Error ? error.message : "The PDF could not be loaded.",
        });
      });

    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [artifact, getAccessToken, retryKey]);

  useEffect(() => {
    if (!artifact) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [artifact, onClose]);

  if (!artifact) return null;
  const displayedState: PreviewState = state.artifactId === artifact.id
    ? state
    : { status: "loading", artifactId: artifact.id };

  return (
    <aside className="artifact-preview" aria-label={`${artifact.name} PDF preview`}>
      <header className="artifact-preview-header">
        <div className="artifact-preview-title">
          <strong>{artifact.name}</strong>
          <span>PDF</span>
        </div>
        <div className="artifact-preview-actions">
          <button
            type="button"
            aria-label={`Download ${artifact.name}`}
            title="Download"
            disabled={displayedState.status !== "ready"}
            onClick={() => {
              if (displayedState.status === "ready") downloadBlob(displayedState.blob, artifact.name);
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 3v12m0 0 4-4m-4 4-4-4M5 20h14" />
            </svg>
          </button>
          <button type="button" aria-label="Close PDF preview" title="Close" onClick={onClose}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
      </header>
      <div className="artifact-preview-body">
        {displayedState.status === "loading" && (
          <div className="artifact-preview-status" role="status">Loading PDF…</div>
        )}
        {displayedState.status === "error" && (
          <div className="artifact-preview-status artifact-preview-error" role="alert">
            <p>{displayedState.message}</p>
            <button
              type="button"
              onClick={() => {
                setState({ status: "loading", artifactId: artifact.id });
                setRetryKey((key) => key + 1);
              }}
            >
              Try again
            </button>
          </div>
        )}
        {displayedState.status === "ready" && (
          <iframe src={`${displayedState.url}#view=FitH`} title={`${artifact.name} PDF`} />
        )}
      </div>
    </aside>
  );
}
