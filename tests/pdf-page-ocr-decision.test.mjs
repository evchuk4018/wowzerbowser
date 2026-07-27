import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
import { parsePdfNatively } from "../app/server/chat/pdf-native-parser.ts";

const fixture = (name) => readFile(new URL(`./fixtures/documents/${name}`, import.meta.url));

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
    reasons: ["native_text_accepted"],
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
    "insufficient_text",
    "low_alphanumeric_ratio",
    "sparse_text_items",
    "image_object_present",
    "image_dominant",
    "dense_visual_content_without_text",
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
    reasons: ["blank_page"],
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
  assert.deepEqual(decision.reasons, ["blank_page"]);
});

test("treats an empty page with unavailable visual analysis as unknown, not blank", () => {
  const decision = decidePdfPageOcr({
    meaningfulCharacterCount: 0,
    textItemCount: 0,
    imageObjectCount: 0,
    imageObjectCountAvailable: false,
  });

  assert.equal(decision.needsOcr, true);
  assert.equal(decision.score, 0.65);
  assert.ok(decision.reasons.includes("visual_analysis_unavailable"));
  assert.ok(!decision.reasons.includes("blank_page"));
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
  assert.deepEqual(decision.reasons, ["corrupt_text", "fragmented_text"]);
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
    "insufficient_text",
    "fragmented_text",
    "sparse_text_items",
    "image_object_present",
    "image_dominant",
    "dense_visual_content_without_text",
  ]);
});

test("treats repeated header/footer-only extraction as OCR-worthy at the inclusive score boundary", () => {
  const decision = decidePdfPageOcr({
    ...nativeText,
    repeatedHeaderFooterOnly: true,
  });

  assert.equal(decision.score, OCR_SCORE_THRESHOLD);
  assert.equal(decision.needsOcr, true);
  assert.deepEqual(decision.reasons, ["repeated_header_footer_only"]);
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
    "corrupt_text",
    "fragmented_text",
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
  assert.equal(atCharacterThreshold.reasons.includes("insufficient_text"), false);
  assert.equal(belowCharacterThreshold.score, 0.2);

  const atAlphanumericThreshold = decidePdfPageOcr({
    ...nativeText,
    alphanumericRatio: LOW_ALPHANUMERIC_RATIO_THRESHOLD,
  });
  const belowAlphanumericThreshold = decidePdfPageOcr({
    ...nativeText,
    alphanumericRatio: LOW_ALPHANUMERIC_RATIO_THRESHOLD - 0.001,
  });
  assert.equal(atAlphanumericThreshold.reasons.includes("low_alphanumeric_ratio"), false);
  assert.deepEqual(belowAlphanumericThreshold.reasons, ["low_alphanumeric_ratio"]);

  const atReplacementThreshold = decidePdfPageOcr({
    ...nativeText,
    unicodeReplacementCharacterRatio: REPLACEMENT_CHARACTER_RATIO_THRESHOLD,
  });
  const belowReplacementThreshold = decidePdfPageOcr({
    ...nativeText,
    unicodeReplacementCharacterRatio: REPLACEMENT_CHARACTER_RATIO_THRESHOLD - 0.001,
  });
  assert.deepEqual(atReplacementThreshold.reasons, ["corrupt_text"]);
  assert.deepEqual(belowReplacementThreshold.reasons, ["native_text_accepted"]);

  const atTokenThreshold = decidePdfPageOcr({
    ...nativeText,
    oneCharacterTokenRatio: ONE_CHARACTER_TOKEN_RATIO_THRESHOLD,
  });
  const belowTokenThreshold = decidePdfPageOcr({
    ...nativeText,
    oneCharacterTokenRatio: ONE_CHARACTER_TOKEN_RATIO_THRESHOLD - 0.001,
  });
  assert.deepEqual(atTokenThreshold.reasons, ["fragmented_text"]);
  assert.deepEqual(belowTokenThreshold.reasons, ["native_text_accepted"]);

  const atItemThreshold = decidePdfPageOcr({
    ...nativeText,
    textItemCount: MIN_TEXT_ITEM_COUNT,
  });
  const belowItemThreshold = decidePdfPageOcr({
    ...nativeText,
    textItemCount: MIN_TEXT_ITEM_COUNT - 1,
  });
  assert.equal(atItemThreshold.reasons.includes("sparse_text_items"), false);
  assert.deepEqual(belowItemThreshold.reasons, ["sparse_text_items"]);

  const atImageCoverageThreshold = decidePdfPageOcr({
    ...nativeText,
    largeImagePageCoverage: LARGE_IMAGE_PAGE_COVERAGE_THRESHOLD,
  });
  const belowImageCoverageThreshold = decidePdfPageOcr({
    ...nativeText,
    largeImagePageCoverage: LARGE_IMAGE_PAGE_COVERAGE_THRESHOLD - 0.001,
  });
  assert.deepEqual(atImageCoverageThreshold.reasons, ["image_dominant"]);
  assert.deepEqual(belowImageCoverageThreshold.reasons, ["native_text_accepted"]);
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
  assert.notEqual(justBelow.reasons[0], "blank_page");
});

test("classifies the scanned, mixed, and corrupt PDF fixtures page by page", async () => {
  const scanned = await parsePdfNatively(await fixture("scanned-page.pdf"));
  assert.equal(scanned.pageOcrDecisions.length, 1);
  assert.equal(scanned.pageOcrDecisions[0].needsOcr, true);
  assert.ok(scanned.pageOcrDecisions[0].reasons.includes("image_dominant"));

  const mixed = await parsePdfNatively(await fixture("mixed-text-and-scan.pdf"));
  assert.deepEqual(mixed.pageOcrDecisions.map((decision) => decision.needsOcr), [false, true]);

  const blank = await parsePdfNatively(await fixture("multi-page-text.pdf"));
  assert.equal(blank.pageOcrDecisions[1].needsOcr, false);
  assert.deepEqual(blank.pageOcrDecisions[1].reasons, ["blank_page"]);

  const corrupt = await parsePdfNatively(await fixture("corrupt-text-layer.pdf"));
  assert.equal(corrupt.pageOcrDecisions[0].needsOcr, true);
  assert.ok(corrupt.pageOcrDecisions[0].reasons.includes("fragmented_text"));
});
