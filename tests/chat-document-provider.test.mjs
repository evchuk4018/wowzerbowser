import test from "node:test";
import assert from "node:assert/strict";
import { estimatePdfTokens, pdfContext, ChatDocumentError } from "../lib/chat-document.ts";
import { parsePdfWithOpenRouter } from "../app/providers/openrouter/openrouter-document-adapter.ts";
import { OPENROUTER_QUOTA_FALLBACK_MODEL } from "../app/providers/openrouter/openrouter-config.ts";
import { DOCUMENT_INGESTION_STAGES, DocumentIngestionTiming } from "../app/server/chat/document-ingestion-timing.ts";

test("PDF token estimate is conservative and small PDFs inline every page",()=>{ assert.equal(estimatePdfTokens("12345"),2); const doc={id:"p",name:"a.pdf",contentType:"application/pdf",size:10,pageCount:2,tokenEstimate:2}; assert.equal(pdfContext(doc,[{pageNumber:1,text:"one"},{pageNumber:2,text:"two"}]).includes("[PDF page 2]\ntwo"),true); });
test("large PDFs contain metadata and no partial text",()=>{ const doc={id:"p",name:"large.pdf",contentType:"application/pdf",size:10,pageCount:50,tokenEstimate:40000}; const value=pdfContext(doc,[{pageNumber:1,text:"SECRET"}]); assert.match(value,/id=p.*pages=50.*40000/s); assert.doesNotMatch(value,/SECRET/); });

test("external PDF parsing sends the signed URL to the free parser and records no request contents",async()=>{
 const originalFetch=globalThis.fetch;
 const originalKey=process.env.OPENROUTER_API_KEY;
 const signedUrl="https://storage.test/storage/v1/object/sign/chat-documents/owner/conversation/document.pdf?token=secret-download-token";
 let requestBody;
 process.env.OPENROUTER_API_KEY="secret-provider-key";
 globalThis.fetch=async(_url,init)=>{
  requestBody=JSON.parse(String(init.body));
  return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({pages:[{pageNumber:1,text:"page text"}]})}}]}),{status:200,headers:{"content-type":"application/json"}});
 };
 try {
  const timing=new DocumentIngestionTiming({documentType:"application/pdf",byteSize:5});
  const pages=await parsePdfWithOpenRouter(signedUrl,"document.pdf",undefined,timing);
  assert.equal(pages.length,1);
  assert.equal(requestBody.model,"openrouter/free");
  assert.equal(requestBody.plugins[0].id,"file-parser");
  assert.equal(requestBody.plugins[0].pdf.engine,"cloudflare-ai");
  assert.equal(requestBody.messages[0].content[0].file.file_data,signedUrl);
  assert.doesNotMatch(JSON.stringify(requestBody),/base64|JVBERi0/);
  assert.equal(timing.snapshot().stageDurations[DOCUMENT_INGESTION_STAGES.EXTERNAL_PARSING]!==undefined,true);
  assert.doesNotMatch(JSON.stringify(timing.toLogEntry()),/secret-provider-key|secret-download-token|page text|document\.pdf/);
 } finally {
  globalThis.fetch=originalFetch;
  if(originalKey===undefined)delete process.env.OPENROUTER_API_KEY;else process.env.OPENROUTER_API_KEY=originalKey;
 }
});

test("external PDF provider transport failures remain ChatDocumentError instances",async()=>{
 const originalFetch=globalThis.fetch;
 const originalKey=process.env.OPENROUTER_API_KEY;
 process.env.OPENROUTER_API_KEY="secret-provider-key";
 globalThis.fetch=async()=>{throw new Error("provider secret");};
 try {
  await assert.rejects(
   parsePdfWithOpenRouter("https://storage.test/document.pdf?token=secret-download-token","document.pdf"),
   (error)=>error instanceof ChatDocumentError && error.code==="parser_unavailable" && error.status===502,
  );
 } finally {
  globalThis.fetch=originalFetch;
  if(originalKey===undefined)delete process.env.OPENROUTER_API_KEY;else process.env.OPENROUTER_API_KEY=originalKey;
 }
});

test("external PDF parsing retries with Qwen3.7 Flash after free quota exhaustion", async () => {
 const originalFetch=globalThis.fetch;
 const originalKey=process.env.OPENROUTER_API_KEY;
 const models=[];
 process.env.OPENROUTER_API_KEY="secret-provider-key";
 globalThis.fetch=async(_url,init)=>{
  const requestBody=JSON.parse(String(init.body));
  models.push(requestBody.model);
  if(models.length===1)return new Response("free quota exhausted",{status:429});
  return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({pages:[{pageNumber:1,text:"qwen page"}]})}}]}),{status:200});
 };
 try {
  const pages=await parsePdfWithOpenRouter("https://storage.test/document.pdf","document.pdf");
  assert.deepEqual(models,["openrouter/free",OPENROUTER_QUOTA_FALLBACK_MODEL]);
  assert.equal(pages[0].text,"qwen page");
 } finally {
  globalThis.fetch=originalFetch;
  if(originalKey===undefined)delete process.env.OPENROUTER_API_KEY;else process.env.OPENROUTER_API_KEY=originalKey;
 }
});
