import type { ChatArtifact } from "../../lib/chat-protocol";

export const PDF_PREVIEW_HISTORY_WIDTH = 300;
export const PDF_PREVIEW_MIN_COLUMN_WIDTH = 360;
export const PDF_PREVIEW_RESIZE_STEP = 24;

function decodedFilename(value: string): string {
  const withoutQuery = value.split(/[?#]/, 1)[0] ?? "";
  const basename = withoutQuery.replace(/\\/g, "/").split("/").pop() ?? "";
  try {
    return decodeURIComponent(basename).trim();
  } catch {
    return basename.trim();
  }
}

function normalizedFilename(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function resolvePdfArtifact(
  href: string | undefined,
  visibleText: string,
  artifacts: readonly ChatArtifact[],
): ChatArtifact | null {
  const pdfs = artifacts.filter((artifact) => artifact.contentType === "application/pdf");
  if (!pdfs.length) return null;

  const candidates = [href ? decodedFilename(href) : "", visibleText.trim()]
    .filter(Boolean)
    .map(normalizedFilename);

  for (const candidate of candidates) {
    const matches = pdfs.filter((artifact) => normalizedFilename(artifact.name) === candidate);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return null;
  }

  const referencesPdf = candidates.some((candidate) => candidate.endsWith(".pdf"));
  return referencesPdf && pdfs.length === 1 ? pdfs[0] : null;
}

export function usesFullscreenPdfPreview(viewportWidth: number): boolean {
  return viewportWidth <
    PDF_PREVIEW_HISTORY_WIDTH + (PDF_PREVIEW_MIN_COLUMN_WIDTH * 2);
}

export function clampPdfPreviewWidth(width: number, viewportWidth: number): number {
  const availableWidth = viewportWidth - PDF_PREVIEW_HISTORY_WIDTH;
  const maximumWidth = Math.max(
    PDF_PREVIEW_MIN_COLUMN_WIDTH,
    availableWidth - PDF_PREVIEW_MIN_COLUMN_WIDTH,
  );
  return Math.min(Math.max(width, PDF_PREVIEW_MIN_COLUMN_WIDTH), maximumWidth);
}

export function defaultPdfPreviewWidth(viewportWidth: number): number {
  const availableWidth = viewportWidth - PDF_PREVIEW_HISTORY_WIDTH;
  return clampPdfPreviewWidth(availableWidth / 2, viewportWidth);
}
