export const ARTIFACT_PREVIEW_HISTORY_WIDTH = 300;
export const ARTIFACT_PREVIEW_MIN_COLUMN_WIDTH = 360;
export const ARTIFACT_PREVIEW_RESIZE_STEP = 24;

export function usesFullscreenArtifactPreview(viewportWidth: number): boolean {
  return viewportWidth <
    ARTIFACT_PREVIEW_HISTORY_WIDTH + (ARTIFACT_PREVIEW_MIN_COLUMN_WIDTH * 2);
}

export function clampArtifactPreviewWidth(width: number, viewportWidth: number): number {
  const availableWidth = viewportWidth - ARTIFACT_PREVIEW_HISTORY_WIDTH;
  const maximumWidth = Math.max(
    ARTIFACT_PREVIEW_MIN_COLUMN_WIDTH,
    availableWidth - ARTIFACT_PREVIEW_MIN_COLUMN_WIDTH,
  );
  return Math.min(Math.max(width, ARTIFACT_PREVIEW_MIN_COLUMN_WIDTH), maximumWidth);
}

export function defaultArtifactPreviewWidth(viewportWidth: number): number {
  const availableWidth = viewportWidth - ARTIFACT_PREVIEW_HISTORY_WIDTH;
  return clampArtifactPreviewWidth(availableWidth / 2, viewportWidth);
}
