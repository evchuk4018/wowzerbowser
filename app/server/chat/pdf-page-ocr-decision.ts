/**
 * Stable, parser-independent signals used to decide whether one PDF page
 * should be sent through OCR.
 *
 * Ratios and coverage values are normalized to [0, 1]. The caller owns the
 * extraction/rendering work; this module only scores already-computed metrics.
 */

/**
 * A page with fewer than this many meaningful characters is unlikely to have
 * a useful native text layer. The value is deliberately larger than a title
 * or short caption so image-only pages with incidental text are still caught.
 */
export const MIN_MEANINGFUL_CHARACTER_COUNT = 80;

/** Below half alphanumeric content, native extraction is usually noise. */
export const LOW_ALPHANUMERIC_RATIO_THRESHOLD = 0.5;

/** Five percent replacement characters is enough to indicate text corruption. */
export const REPLACEMENT_CHARACTER_RATIO_THRESHOLD = 0.05;

/** A majority of one-character tokens is a common symptom of bad extraction. */
export const ONE_CHARACTER_TOKEN_RATIO_THRESHOLD = 0.6;

/** Three text items distinguish ordinary sparse layout from an empty layer. */
export const MIN_TEXT_ITEM_COUNT = 3;

/** An image covering 60% of the page is likely the page's scanned substrate. */
export const LARGE_IMAGE_PAGE_COVERAGE_THRESHOLD = 0.6;

/** Two percent visible ink is enough to distinguish a rendered page from blank. */
export const VISIBLE_CONTENT_COVERAGE_THRESHOLD = 0.02;

/** Coverage at or below 1% is treated as visually blank when other signals agree. */
export const BLANK_PAGE_CONTENT_COVERAGE_THRESHOLD = 0.01;

/** Scores are normalized to [0, 1]; the boundary is inclusive. */
export const OCR_SCORE_THRESHOLD = 0.5;

/** At 25% replacement characters, native text confidence is fully suppressed. */
export const NATIVE_TEXT_CORRUPTION_SATURATION_RATIO = 0.25;

/**
 * Weights for independent OCR evidence. A text-free image page reaches the
 * decision boundary from low text, low alphanumeric content, sparse items,
 * and an image even when optional coverage metrics are unavailable.
 */
export const PDF_PAGE_OCR_SIGNAL_WEIGHTS = Object.freeze({
  lowMeaningfulCharacterCount: 0.2,
  lowAlphanumericRatio: 0.1,
  replacementCharacterRatio: 0.32,
  oneCharacterTokenRatio: 0.2,
  sparseTextItems: 0.1,
  imageObject: 0.2,
  largeImagePageCoverage: 0.14,
  visibleContentWithoutNativeText: 0.1,
  repeatedHeaderFooterOnly: 0.5,
} as const);

/** Machine-readable reason codes returned in a deterministic order. */
export const PDF_PAGE_OCR_REASON_CODES = Object.freeze({
  blankPage: "blank_page",
  lowMeaningfulCharacterCount: "insufficient_text",
  lowAlphanumericRatio: "low_alphanumeric_ratio",
  replacementCharacterRatio: "corrupt_text",
  oneCharacterTokenRatio: "fragmented_text",
  sparseTextItems: "sparse_text_items",
  imageObject: "image_object_present",
  largeImagePageCoverage: "image_dominant",
  visibleContentWithoutNativeText: "dense_visual_content_without_text",
  repeatedHeaderFooterOnly: "repeated_header_footer_only",
  nativeTextSufficient: "native_text_accepted",
} as const);

export type PdfPageOcrReason = typeof PDF_PAGE_OCR_REASON_CODES[keyof typeof PDF_PAGE_OCR_REASON_CODES];

/**
 * Metrics computed by a PDF/text/rendering adapter. Core metrics are optional
 * at the type boundary so adapters can add fields incrementally; absent core
 * metrics are treated as zero evidence of a native text layer. The aliases
 * accommodate the names used by existing and planned page adapters.
 */
export type PdfPageOcrDecisionMetrics = {
  /** Raw extracted text is accepted so adapters need not duplicate these ratios. */
  text?: string | null;
  extractedText?: string | null;
  meaningfulCharacterCount?: number | null;
  meaningfulCharCount?: number | null;
  extractedCharacterCount?: number | null;
  alphanumericRatio?: number | null;
  unicodeReplacementCharacterRatio?: number | null;
  replacementCharacterRatio?: number | null;
  replacementCharRatio?: number | null;
  oneCharacterTokenRatio?: number | null;
  singleCharacterTokenRatio?: number | null;
  oneCharTokenRatio?: number | null;
  textItemCount?: number | null;
  textItems?: number | null;
  imageObjectCount?: number | null;
  imageCount?: number | null;
  largeImagePageCoverage?: number | null;
  largeImageCoverage?: number | null;
  visibleContentCoverage?: number | null;
  inkCoverage?: number | null;
  visibleInkCoverage?: number | null;
  repeatedHeaderFooterOnly?: boolean | null;
  repeatedHeaderFooterOnlyText?: boolean | null;
  isRepeatedHeaderFooterOnly?: boolean | null;
  headerFooterOnly?: boolean | null;
  blankPage?: boolean | null;
  isBlankPage?: boolean | null;
};

export type PdfPageOcrDecision = {
  needsOcr: boolean;
  score: number;
  reasons: PdfPageOcrReason[];
  nativeTextConfidence: number;
};

type MetricKey = keyof PdfPageOcrDecisionMetrics;

function finiteMetric(metrics: PdfPageOcrDecisionMetrics, keys: readonly MetricKey[]): number | undefined {
  for (const key of keys) {
    const value = metrics[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function booleanMetric(metrics: PdfPageOcrDecisionMetrics, keys: readonly MetricKey[]): boolean | undefined {
  for (const key of keys) {
    const value = metrics[key];
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function nonNegativeCount(value: number | undefined): number {
  return value === undefined ? 0 : Math.max(0, Math.floor(value));
}

function normalizedRatio(value: number | undefined): number {
  if (value === undefined) return 0;
  return Math.min(1, Math.max(0, value));
}

function optionalNormalizedRatio(value: number | undefined): number | undefined {
  return value === undefined ? undefined : normalizedRatio(value);
}

function textMetrics(text: string | undefined): {
  meaningfulCharacterCount: number;
  alphanumericRatio: number;
  replacementCharacterRatio: number;
  oneCharacterTokenRatio: number;
} | undefined {
  if (text === undefined) return undefined;
  const meaningfulCharacters = Array.from(text).filter((character) => !/\s/u.test(character));
  const alphanumericCharacters = meaningfulCharacters.filter((character) => /[\p{L}\p{N}]/u.test(character));
  const replacementCharacters = meaningfulCharacters.filter((character) => character === "\uFFFD");
  const tokens = text.trim() ? text.trim().split(/\s+/u) : [];
  const oneCharacterTokens = tokens.filter((token) => Array.from(token).length === 1);
  return {
    meaningfulCharacterCount: meaningfulCharacters.length,
    alphanumericRatio: meaningfulCharacters.length === 0 ? 0 : alphanumericCharacters.length / meaningfulCharacters.length,
    replacementCharacterRatio: meaningfulCharacters.length === 0 ? 0 : replacementCharacters.length / meaningfulCharacters.length,
    oneCharacterTokenRatio: tokens.length === 0 ? 0 : oneCharacterTokens.length / tokens.length,
  };
}

function rounded(value: number): number {
  return Number(Math.min(1, Math.max(0, value)).toFixed(6));
}

function hasMeaningfulVisualContent(
  largeImagePageCoverage: number | undefined,
  visibleContentCoverage: number | undefined,
): boolean {
  return (
    (largeImagePageCoverage !== undefined && largeImagePageCoverage > BLANK_PAGE_CONTENT_COVERAGE_THRESHOLD) ||
    (visibleContentCoverage !== undefined && visibleContentCoverage > BLANK_PAGE_CONTENT_COVERAGE_THRESHOLD)
  );
}

function nativeTextConfidence(input: {
  meaningfulCharacterCount: number;
  alphanumericRatio: number;
  replacementCharacterRatio: number;
  oneCharacterTokenRatio: number;
  textItemCount: number;
  repeatedHeaderFooterOnly: boolean;
}): number {
  if (input.meaningfulCharacterCount === 0) return 0;

  const characterQuality = Math.min(1, input.meaningfulCharacterCount / MIN_MEANINGFUL_CHARACTER_COUNT);
  const textItemQuality = Math.min(1, input.textItemCount / MIN_TEXT_ITEM_COUNT);
  const replacementQuality = Math.max(
    0,
    1 - input.replacementCharacterRatio / NATIVE_TEXT_CORRUPTION_SATURATION_RATIO,
  );
  const confidence =
    characterQuality * 0.3 +
    input.alphanumericRatio * 0.2 +
    replacementQuality * 0.2 +
    (1 - input.oneCharacterTokenRatio) * 0.15 +
    textItemQuality * 0.15;

  // Header/footer-only text is real native text, but is not useful page body
  // content. Cap the reported confidence without making it indistinguishable
  // from a truly empty page.
  return rounded(input.repeatedHeaderFooterOnly ? Math.min(confidence, 0.25) : confidence);
}

/**
 * Decide whether OCR is warranted for one page from explicit page metrics.
 *
 * The result is pure: no PDF parsing, rendering, I/O, clocks, randomness, or
 * provider calls are used. Every threshold comparison is inclusive or
 * exclusive by design and is covered by the focused tests.
 */
export function decidePdfPageOcr(metrics: PdfPageOcrDecisionMetrics): PdfPageOcrDecision {
  const derivedTextMetrics = textMetrics(
    typeof metrics.text === "string" ? metrics.text : typeof metrics.extractedText === "string" ? metrics.extractedText : undefined,
  );
  const meaningfulCharacterCount = nonNegativeCount(
    finiteMetric(metrics, ["meaningfulCharacterCount", "meaningfulCharCount", "extractedCharacterCount"]) ?? derivedTextMetrics?.meaningfulCharacterCount,
  );
  const alphanumericRatio = normalizedRatio(finiteMetric(metrics, ["alphanumericRatio"]) ?? derivedTextMetrics?.alphanumericRatio);
  const replacementCharacterRatio = normalizedRatio(
    finiteMetric(metrics, ["unicodeReplacementCharacterRatio", "replacementCharacterRatio", "replacementCharRatio"]) ?? derivedTextMetrics?.replacementCharacterRatio,
  );
  const oneCharacterTokenRatio = normalizedRatio(
    finiteMetric(metrics, ["oneCharacterTokenRatio", "singleCharacterTokenRatio", "oneCharTokenRatio"]) ?? derivedTextMetrics?.oneCharacterTokenRatio,
  );
  const textItemCount = nonNegativeCount(
    finiteMetric(metrics, ["textItemCount", "textItems"]) ?? (derivedTextMetrics && derivedTextMetrics.meaningfulCharacterCount > 0 ? 1 : 0),
  );
  const imageObjectCount = nonNegativeCount(finiteMetric(metrics, ["imageObjectCount", "imageCount"]));
  const largeImagePageCoverage = optionalNormalizedRatio(
    finiteMetric(metrics, ["largeImagePageCoverage", "largeImageCoverage"]),
  );
  const visibleContentCoverage = optionalNormalizedRatio(
    finiteMetric(metrics, ["visibleContentCoverage", "inkCoverage", "visibleInkCoverage"]),
  );
  const repeatedHeaderFooterOnly =
    booleanMetric(metrics, [
      "repeatedHeaderFooterOnly",
      "repeatedHeaderFooterOnlyText",
      "isRepeatedHeaderFooterOnly",
      "headerFooterOnly",
    ]) ?? false;
  const explicitBlankPage = booleanMetric(metrics, ["blankPage", "isBlankPage"]);
  const inferredBlankPage =
    meaningfulCharacterCount === 0 &&
    imageObjectCount === 0 &&
    alphanumericRatio === 0 &&
    replacementCharacterRatio === 0 &&
    oneCharacterTokenRatio === 0 &&
    !repeatedHeaderFooterOnly &&
    !hasMeaningfulVisualContent(largeImagePageCoverage, visibleContentCoverage);
  const blankPage = explicitBlankPage ?? inferredBlankPage;

  const confidence = nativeTextConfidence({
    meaningfulCharacterCount,
    alphanumericRatio,
    replacementCharacterRatio,
    oneCharacterTokenRatio,
    textItemCount,
    repeatedHeaderFooterOnly,
  });

  // Blank is an absolute stop condition. This also prevents low-text signals
  // from accidentally routing an actually empty page through OCR.
  if (blankPage) {
    return {
      needsOcr: false,
      score: 0,
      reasons: [PDF_PAGE_OCR_REASON_CODES.blankPage],
      nativeTextConfidence: 0,
    };
  }

  let score = 0;
  const reasons: PdfPageOcrReason[] = [];
  const addSignal = (condition: boolean, weight: number, reason: PdfPageOcrReason): void => {
    if (!condition) return;
    score += weight;
    reasons.push(reason);
  };

  addSignal(
    meaningfulCharacterCount < MIN_MEANINGFUL_CHARACTER_COUNT,
    PDF_PAGE_OCR_SIGNAL_WEIGHTS.lowMeaningfulCharacterCount,
    PDF_PAGE_OCR_REASON_CODES.lowMeaningfulCharacterCount,
  );
  addSignal(
    alphanumericRatio < LOW_ALPHANUMERIC_RATIO_THRESHOLD,
    PDF_PAGE_OCR_SIGNAL_WEIGHTS.lowAlphanumericRatio,
    PDF_PAGE_OCR_REASON_CODES.lowAlphanumericRatio,
  );
  addSignal(
    replacementCharacterRatio >= REPLACEMENT_CHARACTER_RATIO_THRESHOLD,
    PDF_PAGE_OCR_SIGNAL_WEIGHTS.replacementCharacterRatio,
    PDF_PAGE_OCR_REASON_CODES.replacementCharacterRatio,
  );
  addSignal(
    oneCharacterTokenRatio >= ONE_CHARACTER_TOKEN_RATIO_THRESHOLD,
    PDF_PAGE_OCR_SIGNAL_WEIGHTS.oneCharacterTokenRatio,
    PDF_PAGE_OCR_REASON_CODES.oneCharacterTokenRatio,
  );
  addSignal(
    textItemCount < MIN_TEXT_ITEM_COUNT,
    PDF_PAGE_OCR_SIGNAL_WEIGHTS.sparseTextItems,
    PDF_PAGE_OCR_REASON_CODES.sparseTextItems,
  );
  addSignal(
    imageObjectCount > 0,
    PDF_PAGE_OCR_SIGNAL_WEIGHTS.imageObject,
    PDF_PAGE_OCR_REASON_CODES.imageObject,
  );
  addSignal(
    largeImagePageCoverage !== undefined && largeImagePageCoverage >= LARGE_IMAGE_PAGE_COVERAGE_THRESHOLD,
    PDF_PAGE_OCR_SIGNAL_WEIGHTS.largeImagePageCoverage,
    PDF_PAGE_OCR_REASON_CODES.largeImagePageCoverage,
  );
  addSignal(
    visibleContentCoverage !== undefined &&
      visibleContentCoverage >= VISIBLE_CONTENT_COVERAGE_THRESHOLD &&
      meaningfulCharacterCount < MIN_MEANINGFUL_CHARACTER_COUNT,
    PDF_PAGE_OCR_SIGNAL_WEIGHTS.visibleContentWithoutNativeText,
    PDF_PAGE_OCR_REASON_CODES.visibleContentWithoutNativeText,
  );
  addSignal(
    repeatedHeaderFooterOnly,
    PDF_PAGE_OCR_SIGNAL_WEIGHTS.repeatedHeaderFooterOnly,
    PDF_PAGE_OCR_REASON_CODES.repeatedHeaderFooterOnly,
  );

  const roundedScore = rounded(score);
  return {
    needsOcr: roundedScore >= OCR_SCORE_THRESHOLD,
    score: roundedScore,
    reasons: reasons.length > 0 ? reasons : [PDF_PAGE_OCR_REASON_CODES.nativeTextSufficient],
    nativeTextConfidence: confidence,
  };
}

// Aliases keep the decision easy to discover for adapters using either name.
export const decidePageOcr = decidePdfPageOcr;
export const shouldOcrPdfPage = decidePdfPageOcr;
