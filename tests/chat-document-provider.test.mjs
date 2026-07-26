import test from "node:test";
import assert from "node:assert/strict";
import { estimatePdfTokens, pdfContext } from "../lib/chat-document.ts";
test("PDF token estimate is conservative and small PDFs inline every page",()=>{ assert.equal(estimatePdfTokens("12345"),2); const doc={id:"p",name:"a.pdf",contentType:"application/pdf",size:10,pageCount:2,tokenEstimate:2}; assert.equal(pdfContext(doc,[{pageNumber:1,text:"one"},{pageNumber:2,text:"two"}]).includes("[PDF page 2]\ntwo"),true); });
test("large PDFs contain metadata and no partial text",()=>{ const doc={id:"p",name:"large.pdf",contentType:"application/pdf",size:10,pageCount:50,tokenEstimate:40000}; const value=pdfContext(doc,[{pageNumber:1,text:"SECRET"}]); assert.match(value,/id=p.*pages=50.*40000/s); assert.doesNotMatch(value,/SECRET/); });
