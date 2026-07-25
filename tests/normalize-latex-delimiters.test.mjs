import assert from "node:assert/strict";
import test from "node:test";
import { normalizeLatexDelimiters } from "../app/chat/normalize-latex-delimiters.ts";

test("normalizes display LaTeX delimiters", () => {
  assert.equal(normalizeLatexDelimiters(String.raw`\[x^2 + y^2\]`), "$$x^2 + y^2$$");
});

test("normalizes inline LaTeX delimiters", () => {
  assert.equal(normalizeLatexDelimiters(String.raw`The value is \(x + 1\).`), "The value is $x + 1$.");
});

test("leaves existing dollar syntax unchanged", () => {
  const content = "Inline $x + 1$ and display $$x^2$$.";
  assert.equal(normalizeLatexDelimiters(content), content);
});

test("preserves fenced and inline code", () => {
  const content = "```latex\n\\[fenced\\]\n\\(code\\)\n```\n\n`\\[inline\\]` and \\[rendered\\]";
  const expected = "```latex\n\\[fenced\\]\n\\(code\\)\n```\n\n`\\[inline\\]` and $$rendered$$";
  assert.equal(normalizeLatexDelimiters(content), expected);
});

test("preserves unmatched delimiters", () => {
  const content = String.raw`Unmatched \[display and unmatched \) closing.`;
  assert.equal(normalizeLatexDelimiters(content), content);
});
