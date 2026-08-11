import "server-only";

/** Signals that native extraction may have dropped visible mathematical content. */
export type PdfMathDiagnosticsInput = {
  text?: string | null;
  visibleContentCoverage?: number | null;
  textCoverage?: number | null;
  textItemCount?: number | null;
  visualElementCount?: number | null;
  imageCount?: number | null;
  renderedPageAvailable?: boolean | null;
};

export type PdfMathDiagnosticsStatus = "healthy" | "likely_missing_math" | "blank" | "uncertain";

export type PdfMathDiagnosticsReason =
  | "math_context_without_native_formula"
  | "visible_content_exceeds_native_text"
  | "low_native_text_coverage"
  | "math_context_near_visual_content"
  | "blank_page"
  | "rendered_content_unavailable"
  | "rendered_content_unmeasured"
  | "native_math_text_present_or_no_math_signal";

export type PdfMathDiagnostics = {
  status: PdfMathDiagnosticsStatus;
  likelyMissingMath: boolean;
  uncertain: boolean;
  needsVisualInspection: boolean;
  score: number;
  reasons: PdfMathDiagnosticsReason[];
  nativeTextHasMath: boolean;
};

export const PDF_MATH_DIAGNOSTIC_THRESHOLDS = Object.freeze({
  minimumVisibleCoverage: 0.02,
  maximumSparseTextCharacters: 160,
  maximumSparseTextItems: 8,
  minimumVisualElements: 2,
  minimumMissingMathScore: 0.5,
  blankContentCoverage: 0.01,
});

const MATH_CONTEXT_PATTERN = /\b(?:integral|integrate|derivative|differentiate|equation|function|parametric|polar|series|sequence|limit|matrix|vector|trigonometric|volume|area|evaluate|solve|find)\b/iu;
const MATH_COMMAND_PATTERN = /\\(?:frac|d?int|sum|prod|sqrt|lim|sin|cos|tan|sec|csc|cot|log|ln|exp|pi|theta|alpha|beta|gamma|cdot|times|left|right)\b/iu;
const FORMULA_PATTERN = /\b[a-z][a-z0-9]*\s*[\^_=]/iu;
const MATH_SYMBOL_CODE_POINTS = new Set([
  0x00b1, 0x00d7, 0x00f7, 0x03b1, 0x03b2, 0x03b3, 0x03b4, 0x03b8, 0x03bb, 0x03bc, 0x03c0,
  0x2202, 0x2207, 0x2208, 0x2209, 0x220f, 0x2211, 0x221a, 0x221d, 0x221e, 0x222b,
  0x2248, 0x2260, 0x2264, 0x2265, 0x2192, 0x21a6,
]);

function ratio(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : undefined;
}
function count(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function rounded(value: number): number {
  return Number(Math.min(1, Math.max(0, value)).toFixed(6));
}

function hasMathSymbolCodePoint(text: string): boolean {
  return Array.from(text).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && MATH_SYMBOL_CODE_POINTS.has(codePoint);
  });
}

export function diagnosePdfMathExtraction(input: PdfMathDiagnosticsInput): PdfMathDiagnostics {
  const text = typeof input.text === "string" ? input.text.trim() : "";
  const visibleContentCoverage = ratio(input.visibleContentCoverage);
  const textCoverage = ratio(input.textCoverage);
  const textItemCount = count(input.textItemCount);
  const visualElementCount = count(input.visualElementCount);
  const imageCount = count(input.imageCount);
  const nativeTextHasMath = MATH_COMMAND_PATTERN.test(text) || FORMULA_PATTERN.test(text) || hasMathSymbolCodePoint(text);
  const hasMathContext = MATH_CONTEXT_PATTERN.test(text);
  const hasVisibleContent = (visibleContentCoverage ?? 0) >= PDF_MATH_DIAGNOSTIC_THRESHOLDS.minimumVisibleCoverage
    || (visualElementCount >= PDF_MATH_DIAGNOSTIC_THRESHOLDS.minimumVisualElements && input.renderedPageAvailable !== false);
  const sparseText = text.length <= PDF_MATH_DIAGNOSTIC_THRESHOLDS.maximumSparseTextCharacters
    || (textItemCount > 0 && textItemCount <= PDF_MATH_DIAGNOSTIC_THRESHOLDS.maximumSparseTextItems);
  const weakTextCoverage = textCoverage !== undefined && textCoverage < 0.01;
  const reasons: PdfMathDiagnosticsReason[] = [];
  let score = 0;
  const add = (condition: boolean, weight: number, reason: PdfMathDiagnosticsReason): void => {
    if (!condition) return;
    score += weight;
    reasons.push(reason);
  };

  add(hasMathContext && !nativeTextHasMath, 0.45, "math_context_without_native_formula");
  add(hasVisibleContent && sparseText && !nativeTextHasMath, 0.3, "visible_content_exceeds_native_text");
  add(weakTextCoverage && hasMathContext, 0.2, "low_native_text_coverage");
  add(imageCount > 0 && hasMathContext && !nativeTextHasMath, 0.15, "math_context_near_visual_content");

  const roundedScore = rounded(score);
  const hasMeasuredVisualContent = visibleContentCoverage !== undefined || visualElementCount > 0 || imageCount > 0;
  const blank = !text
    && (visibleContentCoverage ?? 0) <= PDF_MATH_DIAGNOSTIC_THRESHOLDS.blankContentCoverage
    && visualElementCount === 0
    && imageCount === 0;
  const uncertain = input.renderedPageAvailable === false || (!hasMeasuredVisualContent && Boolean(text));
  if (blank) reasons.push("blank_page");
  else if (input.renderedPageAvailable === false) reasons.push("rendered_content_unavailable");
  else if (!hasMeasuredVisualContent) reasons.push("rendered_content_unmeasured");

  const status: PdfMathDiagnosticsStatus = blank
    ? "blank"
    : roundedScore >= PDF_MATH_DIAGNOSTIC_THRESHOLDS.minimumMissingMathScore
      ? "likely_missing_math"
      : uncertain
        ? "uncertain"
        : "healthy";
  return {
    status,
    likelyMissingMath: status === "likely_missing_math",
    uncertain,
    needsVisualInspection: status === "likely_missing_math" || status === "uncertain",
    score: roundedScore,
    reasons: reasons.length ? reasons : ["native_math_text_present_or_no_math_signal"],
    nativeTextHasMath,
  };
}
