import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parsePdfNatively } from "../app/server/chat/pdf-native-parser.ts";
import { ChatDocumentError } from "../lib/chat-document.ts";

const fixture = (name) => readFile(new URL(`./fixtures/documents/${name}`, import.meta.url));

function repeatedImagePdf() {
  const newline = "\n";
  const content = "q /Im1 Do /Im1 Do Q";
  const objects = [
    ["1 0 obj", "<< /Type /Catalog /Pages 2 0 R >>"],
    ["2 0 obj", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
    ["3 0 obj", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /XObject << /Im1 6 0 R >> >> /Contents 4 0 R >>"],
    ["4 0 obj", `<< /Length ${content.length} >>${newline}stream${newline}${content}${newline}endstream`],
    ["6 0 obj", `<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 3 >>${newline}stream${newline}${String.fromCharCode(0, 0, 0)}${newline}endstream`],
  ];
  let pdf = `%PDF-1.4${newline}`;
  const offsets = [0];
  for (const [head, body] of objects) {
    offsets.push(pdf.length);
    pdf += `${head}${newline}${body}${newline}endobj${newline}`;
  }
  const xref = pdf.length;
  pdf += `xref${newline}0 7${newline}0000000000 65535 f ${newline}`;
  pdf += [offsets[1], offsets[2], offsets[3], offsets[4], 0, offsets[5]]
    .map((offset) => offset ? `${String(offset).padStart(10, "0")} 00000 n ${newline}` : `0000000000 00000 f ${newline}`)
    .join("");
  pdf += `trailer${newline}<< /Size 7 /Root 1 0 R >>${newline}startxref${newline}${xref}${newline}%%EOF${newline}`;
  return Buffer.from(pdf, "binary");
}

test("extracts text-layer PDF metadata and page dimensions locally", async () => {
  const parsed = await parsePdfNatively(await fixture("text-layer.pdf"));
  assert.equal(parsed.pageCount, 1);
  assert.equal(parsed.pages.length, 1);
  assert.deepEqual(parsed.pages[0], {
    pageNumber: 1,
    text: "Native text layer fixture",
    textItemCount: 1,
    imageObjectCount: 0,
    pageWidth: 612,
    pageHeight: 792,
  });
  assert.equal(parsed.textItemCount, 1);
  assert.equal(parsed.imageObjectCount, 0);
  assert.deepEqual(parsed.extractionQuality, {
    hasTextLayer: true,
    pagesWithText: 1,
    pagesWithoutText: 0,
    pagesWithImages: 0,
    emptyPageCount: 0,
    textCharacterCount: "Native text layer fixture".length,
    imageObjectCountAvailable: true,
  });
});

test("preserves page order and represents empty pages", async () => {
  const parsed = await parsePdfNatively(await fixture("multi-page-text.pdf"));
  assert.equal(parsed.pageCount, 3);
  assert.deepEqual(parsed.pages.map((page) => page.pageNumber), [1, 2, 3]);
  assert.deepEqual(parsed.pages.map((page) => page.text), ["First page text", "", "Third page text"]);
  assert.deepEqual(parsed.pages.map((page) => [page.pageWidth, page.pageHeight]), [[612, 792], [400, 500], [800, 600]]);
  assert.equal(parsed.extractionQuality.emptyPageCount, 1);
  assert.equal(parsed.extractionQuality.pagesWithoutText, 1);
});

test("counts unique image objects when the operator list exposes object ids", async () => {
  const parsed = await parsePdfNatively(repeatedImagePdf());
  assert.equal(parsed.pages[0].imageObjectCount, 1);
  assert.equal(parsed.imageObjectCount, 1);
  assert.equal(parsed.extractionQuality.pagesWithImages, 1);
  assert.equal(parsed.extractionQuality.imageObjectCountAvailable, true);
});

test("returns a controlled error for invalid PDFs", async () => {
  await assert.rejects(
    () => parsePdfNatively(new TextEncoder().encode("%PDF-not-a-real-document")),
    (error) => error instanceof ChatDocumentError && error.code === "pdf_parser_failed" && error.status === 400,
  );
});
