import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { parseDocx, splitDocxLogicalPages } from "../app/server/chat/docx-parser.ts";

async function docxWith(documentXml, extras = {}) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${documentXml}</w:body></w:document>`);
  for (const [path, value] of Object.entries(extras)) zip.file(path, value);
  return new Uint8Array(await zip.generateAsync({ type: "uint8array" }));
}

test("extracts paragraphs and table cells in document order", async () => {
  const bytes = await docxWith(`<w:p><w:r><w:t>First paragraph</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell one</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Cell two</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>Last paragraph</w:t></w:r></w:p>`);
  const parsed = await parseDocx(bytes);
  assert.match(parsed.pages.map((page) => page.text).join("\n"), /First paragraph[\s\S]*Cell one[\s\S]*Cell two[\s\S]*Last paragraph/);
  assert.equal(parsed.imageCount, 0);
});

test("logical pages are deterministic, bounded, and preserve all text", () => {
  const text = `${"a".repeat(7_990)}\n\nsecond\n\n${"z".repeat(8_050)}`;
  const pages = splitDocxLogicalPages(text);
  assert.ok(pages.every((page) => page.text.length <= 8_000));
  const reconstructed = pages.map((page) => page.text).join("\n\n");
  assert.equal((reconstructed.match(/a/g) ?? []).length, 7_990);
  assert.equal((reconstructed.match(/z/g) ?? []).length, 8_050);
  assert.match(reconstructed, /second/);
});

test("rejects malformed ZIP files renamed to DOCX", async () => {
  await assert.rejects(() => parseDocx(new TextEncoder().encode("not a zip")), /valid DOCX/);
});
