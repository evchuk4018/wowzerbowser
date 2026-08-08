"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatArtifact } from "../../lib/chat-protocol";
import {
  fetchChatArtifact,
  readWorkspaceFileContent,
  saveWorkspaceFile,
} from "./chat-service";
import {
  clampArtifactPreviewWidth,
  defaultArtifactPreviewWidth,
} from "./artifact-preview-layout";
import {
  clampPdfPreviewWidth,
  defaultPdfPreviewWidth,
} from "./pdf-preview-layout";
import type { PdfPreviewLoadState } from "./pdf-preview-panel";

export type PdfPreviewState = {
  artifact: ChatArtifact;
  loadState: PdfPreviewLoadState;
};

export type ArtifactPreviewState = {
  artifact: ChatArtifact & { content: string };
  loadState: "loading" | "ready" | "error";
  errorMessage?: string;
};

type UseChatPreviewsOptions = {
  conversationId: string;
  hasSession: () => Promise<boolean>;
};

export function useChatPreviews({ conversationId, hasSession }: UseChatPreviewsOptions) {
  const [pdfPreview, setPdfPreview] = useState<PdfPreviewState | null>(null);
  const [pdfPreviewWidth, setPdfPreviewWidth] = useState(360);
  const [artifactPreview, setArtifactPreview] = useState<ArtifactPreviewState | null>(null);
  const [artifactPreviewWidth, setArtifactPreviewWidth] = useState(450);
  const pdfPreviewUrlRef = useRef<string | null>(null);
  const pdfPreviewRequestRef = useRef(0);
  const artifactPreviewRequestRef = useRef(0);

  const releasePdfPreviewUrl = useCallback(() => {
    if (!pdfPreviewUrlRef.current) return;
    URL.revokeObjectURL(pdfPreviewUrlRef.current);
    pdfPreviewUrlRef.current = null;
  }, []);

  const closePdfPreview = useCallback(() => {
    pdfPreviewRequestRef.current += 1;
    releasePdfPreviewUrl();
    setPdfPreview(null);
  }, [releasePdfPreviewUrl]);

  const closeArtifactPreview = useCallback(() => {
    artifactPreviewRequestRef.current += 1;
    setArtifactPreview(null);
  }, []);

  const openPdfPreview = useCallback((artifact: ChatArtifact) => {
    const requestId = pdfPreviewRequestRef.current + 1;
    pdfPreviewRequestRef.current = requestId;
    releasePdfPreviewUrl();
    setPdfPreviewWidth(defaultPdfPreviewWidth(window.innerWidth));
    setPdfPreview({ artifact, loadState: { status: "loading" } });

    void (async () => {
      try {
        const sessionReady = await hasSession();
        if (!sessionReady) throw new Error("Your session expired. Sign in and try again.");
        const blob = await fetchChatArtifact(artifact);
        const url = URL.createObjectURL(blob);
        if (pdfPreviewRequestRef.current !== requestId) {
          URL.revokeObjectURL(url);
          return;
        }
        pdfPreviewUrlRef.current = url;
        setPdfPreview({ artifact, loadState: { status: "loaded", blob, url } });
      } catch {
        if (pdfPreviewRequestRef.current !== requestId) return;
        setPdfPreview({
          artifact,
          loadState: {
            status: "error",
            message: "The PDF could not be loaded.",
          },
        });
      }
    })();
  }, [hasSession, releasePdfPreviewUrl]);

  const openArtifactPreview = useCallback((artifact: ChatArtifact) => {
    if (artifact.contentType === "application/pdf") {
      closeArtifactPreview();
      openPdfPreview(artifact);
      return;
    }
    closePdfPreview();
    const requestId = artifactPreviewRequestRef.current + 1;
    artifactPreviewRequestRef.current = requestId;
    setArtifactPreviewWidth(defaultArtifactPreviewWidth(window.innerWidth));
    setArtifactPreview({ artifact: { ...artifact, content: "" }, loadState: "loading" });
    void (async () => {
      try {
        if (!(await hasSession())) throw new Error("Your session expired. Sign in and try again.");
        const isWorkspaceImage = Boolean(artifact.workspacePath)
          && (artifact.preview === "image" || artifact.contentType.split(";", 1)[0].trim().toLowerCase().startsWith("image/"))
          && artifact.preview !== "svg";
        let content = "";
        let currentArtifact: ChatArtifact & { content: string } = { ...artifact, content: "" };
        if (isWorkspaceImage) {
          currentArtifact = { ...artifact, content: "" };
        } else if (artifact.workspacePath) {
          try {
            const workspace = await readWorkspaceFileContent(conversationId, artifact.workspacePath);
            content = workspace.content;
            currentArtifact = { ...artifact, content, name: workspace.file.name, contentType: workspace.file.contentType, language: workspace.file.language, preview: workspace.file.preview, workspacePath: workspace.file.path, sha256: workspace.file.sha256, editable: workspace.file.editable };
          } catch {
            content = await (await fetchChatArtifact(artifact)).text();
            currentArtifact = { ...artifact, content };
          }
        } else {
          content = await (await fetchChatArtifact(artifact)).text();
          currentArtifact = { ...artifact, content };
        }
        if (artifactPreviewRequestRef.current !== requestId) return;
        setArtifactPreview({ artifact: currentArtifact, loadState: "ready" });
      } catch (error) {
        if (artifactPreviewRequestRef.current !== requestId) return;
        setArtifactPreview({
          artifact: { ...artifact, content: "" },
          loadState: "error",
          errorMessage: error instanceof Error ? error.message : "The file could not be loaded.",
        });
      }
    })();
  }, [closeArtifactPreview, closePdfPreview, conversationId, hasSession, openPdfPreview]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      closePdfPreview();
      closeArtifactPreview();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [closeArtifactPreview, closePdfPreview, conversationId]);

  useEffect(() => {
    const handleResize = () => {
      setPdfPreviewWidth((width) => clampPdfPreviewWidth(width, window.innerWidth));
      setArtifactPreviewWidth((width) => clampArtifactPreviewWidth(width, window.innerWidth));
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => () => {
    pdfPreviewRequestRef.current += 1;
    artifactPreviewRequestRef.current += 1;
    releasePdfPreviewUrl();
  }, [releasePdfPreviewUrl]);

  const updateArtifactPreview = useCallback((content: string) => {
    setArtifactPreview((current) => current
      ? { ...current, artifact: { ...current.artifact, content } }
      : current);
  }, []);

  const saveArtifactPreview = useCallback(async (artifact: ChatArtifact & { content: string }, content: string) => {
    if (!artifact.workspacePath) throw new Error("This artifact is not backed by an editable workspace file.");
    const saved = await saveWorkspaceFile(conversationId, artifact.workspacePath, content, artifact.sha256);
    setArtifactPreview((current) => current ? {
      ...current,
      artifact: {
        ...current.artifact,
        content: saved.content,
        name: saved.file.name,
        contentType: saved.file.contentType,
        language: saved.file.language,
        preview: saved.file.preview,
        sha256: saved.file.sha256,
        workspacePath: saved.file.path,
      },
    } : current);
  }, [conversationId]);

  return {
    pdfPreview,
    pdfPreviewWidth,
    setPdfPreviewWidth,
    artifactPreview,
    artifactPreviewWidth,
    setArtifactPreviewWidth,
    openPdfPreview,
    closePdfPreview,
    openArtifactPreview,
    closeArtifactPreview,
    updateArtifactPreview,
    saveArtifactPreview,
  };
}
