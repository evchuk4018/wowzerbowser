import test from "node:test";
import assert from "node:assert/strict";
import {
  BLANK_PAGE_CONTENT_COVERAGE_THRESHOLD,
  LARGE_IMAGE_PAGE_COVERAGE_THRESHOLD,
  LOW_ALPHANUMERIC_RATIO_THRESHOLD,
  MIN_MEANINGFUL_CHARACTER_COUNT,
  MIN_TEXT_ITEM_COUNT,
  OCR_SCORE_THRESHOLD,
  ONE_CHARACTER_TOKEN_RATIO_THRESHOLD,
  REPLACEMENT_CHARACTER_RATIO_THRESHOLD,
  VISIBLE_CONTENT_COVERAGE_THRESHOLD,
  decidePdfPageOcr,
} from "../app/server/chat/pdf-page-ocr-decision.ts";

const nativeText = {
  meaningfulCharacterCount: 240,
  alphanumericRatio: 0.86,
  unicodeReplacementCharacterRatio: 0,
  oneCharacterTokenRatio: 0.08,
  textItemCount: 18,
  imageObjectCount: 0,
};

test("keeps a healthy native text page out of OCR", () => {
  const decision = decidePdfPageOcr(nativeText);

  assert.deepEqual(decision, {
    needsOcr: false,
    score: 0,
    reasons: ["native-text-sufficient"],
    nativeTextConfidence: 0.96,
  });
});

test("routes a scanned page to OCR from image and missing-text signals", () => {
  const decision = decidePdfPageOcr({
    meaningfulCharacterCount: 0,
    alphanumericRatio: 0,
    unicodeReplacementCharacterRatio: 0,
    oneCharacterTokenRatio: 0,
    textItemCount: 0,
    imageObjectCount: 1,
    largeImagePageCoverage: 0.9,
    visibleContentCoverage: 0.72,
  });

  assert.equal(decision.needsOcr, true);
  assert.equal(decision.nativeTextConfidence, 0);
  assert.equal(decision.score, 0.84);
  assert.deepEqual(decision.reasons, [
    "low-meaningful-character-count",
    "low-alphanumeric-ratio",
    "sparse-text-items",
    "image-object-present",
    "large-image-page-coverage",
    "visible-content-without-native-text",
  ]);
});

test("never sends an explicitly blank page to OCR", () => {
  const decision = decidePdfPageOcr({
    blankPage: true,
    meaningfulCharacterCount: 0,
    alphanumericRatio: 0,
    oneCharacterTokenRatio: 0,
    textItemCount: 0,
    imageObjectCount: 0,
  });

  assert.deepEqual(decision, {
    needsOcr: false,
    score: 0,
    reasons: ["blank-page"],
    nativeTextConfidence: 0,
  });
});

test("infers a blank page from empty native and visual metrics", () => {
  const decision = decidePdfPageOcr({
    meaningfulCharacterCount: 0,
    alphanumericRatio: 0,
    replacementCharacterRatio: 0,
    oneCharacterTokenRatio: 0,
    textItemCount: 4,
    imageObjectCount: 0,
    inkCoverage: BLANK_PAGE_CONTENT_COVERAGE_THRESHOLD,
  });

  assert.equal(decision.needsOcr, false);
  assert.deepEqual(decision.reasons, ["blank-page"]);
});

test("routes corrupt native text to OCR", () => {
  const decision = decidePdfPageOcr({
    meaningfulCharacterCount: 120,
    alphanumericRatio: 0.82,
    unicodeReplacementCharacterRatio: 0.12,
    oneCharacterTokenRatio: 0.7,
    textItemCount: 12,
    imageObjectCount: 0,
  });

  assert.equal(decision.needsOcr, true);
  assert.equal(decision.score, 0.52);
  assert.deepEqual(decision.reasons, ["replacement-character-ratio", "one-character-token-ratio"]);
  assert.ok(decision.nativeTextConfidence < 0.8);
});

test("routes a mixed page with a weak text layer and large image to OCR", () => {
  const decision = decidePdfPageOcr({
    meaningfulCharacterCount: 30,
    alphanumericRatio: 0.78,
    unicodeReplacementCharacterRatio: 0.01,
    oneCharacterTokenRatio: 0.7,
    textItemCount: 2,
    imageObjectCount: 1,
    largeImagePageCoverage: 0.85,
    visibleContentCoverage: 0.4,
  });

  assert.equal(decision.needsOcr, true);
  assert.equal(decision.score, 0.94);
  assert.deepEqual(decision.reasons, [
    "low-meaningful-character-count",
    "one-character-token-ratio",
    "sparse-text-items",
    "image-object-present",
    "large-image-page-coverage",
    "visible-content-without-native-text",
  ]);
});

test("treats repeated header/footer-only extraction as OCR-worthy at the inclusive score boundary", () => {
  const decision = decidePdfPageOcr({
    ...nativeText,
    repeatedHeaderFooterOnly: true,
  });

  assert.equal(decision.score, OCR_SCORE_THRESHOLD);
  assert.equal(decision.needsOcr, true);
  assert.deepEqual(decision.reasons, ["repeated-header-footer-only"]);
  assert.equal(decision.nativeTextConfidence, 0.25);
});

test("uses aliases for replacement, ink, image, and repeated-text hints", () => {
  const decision = decidePdfPageOcr({
    meaningfulCharCount: 120,
    alphanumericRatio: 0.82,
    replacementCharRatio: REPLACEMENT_CHARACTER_RATIO_THRESHOLD,
    oneCharTokenRatio: ONE_CHARACTER_TOKEN_RATIO_THRESHOLD,
    textItems: MIN_TEXT_ITEM_COUNT,
    imageCount: 0,
    visibleInkCoverage: VISIBLE_CONTENT_COVERAGE_THRESHOLD,
    headerFooterOnly: false,
  });

  assert.equal(decision.needsOcr, true);
  assert.equal(decision.score, 0.52);
  assert.deepEqual(decision.reasons, [
    "replacement-character-ratio",
    "one-character-token-ratio",
  ]);
});

test("honors exact threshold boundaries for each binary signal", () => {
  const atCharacterThreshold = decidePdfPageOcr({
    ...nativeText,
    meaningfulCharacterCount: MIN_MEANINGFUL_CHARACTER_COUNT,
  });
  const belowCharacterThreshold = decidePdfPageOcr({
    ...nativeText,
    meaningfulCharacterCount: MIN_MEANINGFUL_CHARACTER_COUNT - 1,
  });
  assert.equal(atCharacterThreshold.reasons.includes("low-meaningful-character-count"), false);
  assert.equal(belowCharacterThreshold.score, 0.2);

  const atAlphanumericThreshold = decidePdfPageOcr({
    ...nativeText,
    alphanumericRatio: LOW_ALPHANUMERIC_RATIO_THRESHOLD,
  });
  const belowAlphanumericThreshold = decidePdfPageOcr({
    ...nativeText,
    alphanumericRatio: LOW_ALPHANUMERIC_RATIO_THRESHOLD - 0.001,
  });
  assert.equal(atAlphanumericThreshold.reasons.includes("low-alphanumeric-ratio"), false);
  assert.deepEqual(belowAlphanumericThreshold.reasons, ["low-alphanumeric-ratio"]);

  const atReplacementThreshold = decidePdfPageOcr({
    ...nativeText,
    unicodeReplacementCharacterRatio: REPLACEMENT_CHARACTER_RATIO_THRESHOLD,
  });
  const belowReplacementThreshold = decidePdfPageOcr({
    ...nativeText,
    unicodeReplacementCharacterRatio: REPLACEMENT_CHARACTER_RATIO_THRESHOLD - 0.001,
  });
  assert.deepEqual(atReplacementThreshold.reasons, ["replacement-character-ratio"]);
  assert.deepEqual(belowReplacementThreshold.reasons, ["native-text-sufficient"]);

  const atTokenThreshold = decidePdfPageOcr({
    ...nativeText,
    oneCharacterTokenRatio: ONE_CHARACTER_TOKEN_RATIO_THRESHOLD,
  });
  const belowTokenThreshold = decidePdfPageOcr({
    ...nativeText,
    oneCharacterTokenRatio: ONE_CHARACTER_TOKEN_RATIO_THRESHOLD - 0.001,
  });
  assert.deepEqual(atTokenThreshold.reasons, ["one-character-token-ratio"]);
  assert.deepEqual(belowTokenThreshold.reasons, ["native-text-sufficient"]);

  const atItemThreshold = decidePdfPageOcr({
    ...nativeText,
    textItemCount: MIN_TEXT_ITEM_COUNT,
  });
  const belowItemThreshold = decidePdfPageOcr({
    ...nativeText,
    textItemCount: MIN_TEXT_ITEM_COUNT - 1,
  });
  assert.equal(atItemThreshold.reasons.includes("sparse-text-items"), false);
  assert.deepEqual(belowItemThreshold.reasons, ["sparse-text-items"]);

  const atImageCoverageThreshold = decidePdfPageOcr({
    ...nativeText,
    largeImagePageCoverage: LARGE_IMAGE_PAGE_COVERAGE_THRESHOLD,
  });
  const belowImageCoverageThreshold = decidePdfPageOcr({
    ...nativeText,
    largeImagePageCoverage: LARGE_IMAGE_PAGE_COVERAGE_THRESHOLD - 0.001,
  });
  assert.deepEqual(atImageCoverageThreshold.reasons, ["large-image-page-coverage"]);
  assert.deepEqual(belowImageCoverageThreshold.reasons, ["native-text-sufficient"]);
});

test("uses visible content exactly at its threshold and does not treat just-below ink as blank", () => {
  const atThreshold = decidePdfPageOcr({
    meaningfulCharacterCount: 0,
    alphanumericRatio: 0,
    oneCharacterTokenRatio: 0,
    textItemCount: 0,
    imageObjectCount: 0,
    visibleContentCoverage: VISIBLE_CONTENT_COVERAGE_THRESHOLD,
  });
  const justBelow = decidePdfPageOcr({
    meaningfulCharacterCount: 0,
    alphanumericRatio: 0,
    oneCharacterTokenRatio: 0,
    textItemCount: 0,
    imageObjectCount: 0,
    visibleContentCoverage: VISIBLE_CONTENT_COVERAGE_THRESHOLD - 0.001,
  });

  assert.equal(atThreshold.score, OCR_SCORE_THRESHOLD);
  assert.equal(atThreshold.needsOcr, true);
  assert.equal(justBelow.needsOcr, false);
  assert.notEqual(justBelow.reasons[0], "blank-page");
});
