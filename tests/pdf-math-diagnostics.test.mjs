import assert from "node:assert/strict";
import test from "node:test";
import { diagnosePdfMathExtraction } from "../app/server/chat/pdf-math-diagnostics.ts";

test("healthy native math text is not flagged", () => {
  const result = diagnosePdfMathExtraction({ text: "Evaluate ∫₀¹ x² dx.", visibleContentCoverage: 0.08, textItemCount: 12, visualElementCount: 4, renderedPageAvailable: true });
  assert.equal(result.likelyMissingMath, false);
  assert.equal(result.nativeTextHasMath, true);
});

test("math context with visible sparse content is flagged", () => {
  const result = diagnosePdfMathExtraction({ text: "Use integration by parts to evaluate the integral:", visibleContentCoverage: 0.08, textItemCount: 3, visualElementCount: 3, renderedPageAvailable: true });
  assert.equal(result.likelyMissingMath, true);
  assert.ok(result.reasons.includes("math_context_without_native_formula"));
});

test("ordinary sparse text is not flagged without math context", () => {
  const result = diagnosePdfMathExtraction({ text: "Report", visibleContentCoverage: 0.08, textItemCount: 1, visualElementCount: 3, renderedPageAvailable: true });
  assert.equal(result.likelyMissingMath, false);
});

test("unavailable rendered content does not create a false visual signal", () => {
  const result = diagnosePdfMathExtraction({ text: "Evaluate the integral:", textItemCount: 3, visualElementCount: 3, renderedPageAvailable: false });
  assert.equal(result.likelyMissingMath, false);
});
