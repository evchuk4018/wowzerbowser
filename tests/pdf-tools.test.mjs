import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { MAX_INLINE_PDF_TOKENS,MAX_INLINE_PDF_PAGES,MAX_PDF_PAGES_PER_READ,MAX_PDF_SEARCH_RESULTS } from "../lib/chat-document.ts";
import { availablePdfTools } from "../app/server/agent/pdf-tool.ts";
test("document limits and gating",()=>{assert.deepEqual([MAX_INLINE_PDF_TOKENS,MAX_INLINE_PDF_PAGES,MAX_PDF_PAGES_PER_READ,MAX_PDF_SEARCH_RESULTS],[32000,40,20,10]);assert.equal(availablePdfTools(false).length,0);assert.deepEqual(availablePdfTools(true).map(x=>x.function.name),["search_document","read_document_pages","inspect_document_page","inspect_document_pages"]);assert.deepEqual(availablePdfTools(true,false).map(x=>x.function.name),["search_document","read_document_pages"]);});
test("document tools keep search text-only and read Markdown-aware",async()=>{
 const [tool,manifest]=await Promise.all([
  readFile(new URL("../app/server/agent/pdf-tool.ts",import.meta.url),"utf8"),
  readFile(new URL("../app/server/agent/pdf-tool-manifest.ts",import.meta.url),"utf8"),
 ]);
 assert.match(tool,/const lower = page\.text\.toLocaleLowerCase\(\)/);
 assert.match(tool,/documentPageMarkdown\(p\)/);
 assert.match(manifest,/Read Markdown/);
  assert.match(manifest,/plain-text extraction/);
  assert.match(manifest,/inspect_document_page/);
  assert.match(manifest,/inspect_document_pages/);
});
