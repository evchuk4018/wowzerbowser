import test from "node:test";
import assert from "node:assert/strict";
import { MAX_INLINE_PDF_TOKENS,MAX_INLINE_PDF_PAGES,MAX_PDF_PAGES_PER_READ,MAX_PDF_SEARCH_RESULTS } from "../lib/chat-document.ts";
import { availablePdfTools } from "../app/server/agent/pdf-tool.ts";
test("document limits and gating",()=>{assert.deepEqual([MAX_INLINE_PDF_TOKENS,MAX_INLINE_PDF_PAGES,MAX_PDF_PAGES_PER_READ,MAX_PDF_SEARCH_RESULTS],[32000,40,20,10]);assert.equal(availablePdfTools(false).length,0);assert.deepEqual(availablePdfTools(true).map(x=>x.function.name),["search_document","read_document_pages"]);});
