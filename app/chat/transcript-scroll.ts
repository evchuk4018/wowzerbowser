export const TRANSCRIPT_BOTTOM_THRESHOLD_PX = 1;

export type TranscriptScrollMetrics = {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
};

export function isTranscriptNearBottom(
  metrics: TranscriptScrollMetrics,
  thresholdPx = TRANSCRIPT_BOTTOM_THRESHOLD_PX,
): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= thresholdPx;
}
