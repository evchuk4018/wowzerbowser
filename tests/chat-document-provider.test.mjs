import test from "node:test";
import assert from "node:assert/strict";
import { estimatePdfTokens, pdfContext, documentContext, createInlineDocumentPageLoader } from "../lib/chat-document.ts";

test("PDF token estimate is conservative and small PDFs inline every page",()=>{ assert.equal(estimatePdfTokens("12345"),2); const doc={id:"p",name:"a.pdf",contentType:"application/pdf",size:10,pageCount:2,tokenEstimate:2}; assert.equal(pdfContext(doc,[{pageNumber:1,text:"one"},{pageNumber:2,text:"two"}]).includes("[PDF page 2]\ntwo"),true); });
test("large PDFs contain metadata and no partial text",()=>{ const doc={id:"p",name:"large.pdf",contentType:"application/pdf",size:10,pageCount:50,tokenEstimate:40000}; const value=pdfContext(doc,[{pageNumber:1,text:"SECRET"}]); assert.match(value,/id=p.*pages=50.*40000/s); assert.doesNotMatch(value,/SECRET/); });
test("PDF context prefers stored Markdown and legacy pages fall back to text",()=>{
 const doc={id:"p",name:"report.pdf",contentType:"application/pdf",size:10,pageCount:2,tokenEstimate:10};
 const value=pdfContext(doc,[{pageNumber:1,text:"plain search text",markdown:"# Report\n\n| Value |\n| --- |\n| 42 |"},{pageNumber:2,text:"legacy page"}]);
 assert.match(value,/# Report/);
 assert.match(value,/legacy page/);
 assert.doesNotMatch(value,/plain search text/);
});
test("DOCX context preserves its existing plain-text page representation",()=>{
 const doc={id:"d",name:"report.docx",contentType:"application/vnd.openxmlformats-officedocument.wordprocessingml.document",size:10,pageCount:1,tokenEstimate:2,hasImages:false,imageCount:0,analyzedImageCount:0,imageAnalyses:[]};
 assert.match(documentContext(doc,[{pageNumber:1,text:"DOCX text"}]),/DOCX text/);
});
test("inline page loader skips large documents and deduplicates small document reads", async () => {
 const calls=[];
 const loader=createInlineDocumentPageLoader(async (document) => { calls.push(document.id); return [{pageNumber:1,text:document.name}]; });
 const small={id:"small",name:"small.pdf",contentType:"application/pdf",size:10,pageCount:1,tokenEstimate:10};
 const large={id:"large",name:"large.pdf",contentType:"application/pdf",size:10,pageCount:41,tokenEstimate:10};
 const [first,second,skipped]=await Promise.all([loader(small),loader(small),loader(large)]);
 assert.deepEqual(first,second);
 assert.deepEqual(skipped,[]);
 assert.deepEqual(calls,["small"]);
});
