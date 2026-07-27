import test from "node:test";
import assert from "node:assert/strict";
import { ChatDocumentError } from "../lib/chat-document.ts";
import { CHAT_DOCUMENT_DOWNLOAD_URL_EXPIRATION_SECONDS, createSignedDocumentDownloadUrl } from "../app/server/chat/chat-document-store.ts";
import { createUploadUrlHandler } from "../app/api/chat/documents/upload-url/route.ts";
import { createFinalizeHandler, maxDuration, runtime } from "../app/api/chat/documents/finalize/route.ts";
import { createDeleteHandler } from "../app/api/chat/documents/delete/route.ts";
import nextConfig from "../next.config.ts";

test("upload URL route rejects unauthorized calls without reading PDF bytes",async()=>{const handler=createUploadUrlHandler({authorizeOwnerSession:async()=>null,createSignedDocumentUpload:async()=>{throw Error("not called")},ensureChatDocumentSchema:async()=>{throw Error("not called")}});const response=await handler(new Request("http://test",{method:"POST"}));assert.equal(response.status,401);});
test("upload URL route reports a safe signed-upload timing stage",async()=>{const logs=[];const original=console.info;console.info=(entry)=>logs.push(entry);try{const handler=createUploadUrlHandler({authorizeOwnerSession:async()=>({id:"owner"}),createSignedDocumentUpload:async()=>({path:"owner/conversation/document.pdf",token:"secret-token",signedUrl:"https://storage.test/signed?token=secret-token"}),ensureChatDocumentSchema:async()=>{}});const response=await handler(new Request("http://test",{method:"POST",headers:{authorization:"Bearer access-token", "content-type":"application/json"},body:JSON.stringify({conversationId:"conversation",documentId:"document",size:12,contentType:"application/pdf"})}));assert.equal(response.status,200);assert.match(response.headers.get("Server-Timing"),/signed-upload-url;dur=/);assert.doesNotMatch(JSON.stringify(logs),/secret-token|access-token|owner\/conversation/);}finally{console.info=original;}});

test("upload URL route reports missing document schema as a structured 503",async()=>{
 const handler=createUploadUrlHandler({
  authorizeOwnerSession:async()=>({id:"owner"}),
  createSignedDocumentUpload:async()=>{throw Error("not called")},
  ensureChatDocumentSchema:async()=>{throw new ChatDocumentError("document_schema_unavailable","The document database schema is not ready. Apply the document migrations and retry.",503);},
 });
 const response=await handler(new Request("http://test",{method:"POST",headers:{authorization:"Bearer access-token","content-type":"application/json"},body:JSON.stringify({conversationId:"conversation",documentId:"document",size:12,contentType:"application/pdf"})}));
 assert.equal(response.status,503);
 assert.deepEqual(await response.json(),{error:"The document database schema is not ready. Apply the document migrations and retry.",code:"document_schema_unavailable",failedStage:"database-registration"});
});

test("finalize route uses the Node runtime and long duration required for PDF ingestion",()=>{
 assert.equal(runtime,"nodejs");
 assert.equal(maxDuration,300);
});

test("Next traces native canvas for both PDF execution routes",()=>{
 assert.deepEqual(nextConfig.serverExternalPackages,["@napi-rs/canvas","pdfjs-dist"]);
 const includes=nextConfig.outputFileTracingIncludes;
 for(const route of ["/api/chat","/api/chat/documents/finalize"]){
  assert.ok(includes?.[route]?.some((entry)=>entry.includes("pdfjs-dist")));
  assert.ok(includes?.[route]?.some((entry)=>entry.includes("@napi-rs/canvas-linux-x64-gnu")));
  assert.ok(includes?.[route]?.some((entry)=>entry.includes("@napi-rs/canvas-linux-x64-musl")));
  assert.ok(includes?.[route]?.some((entry)=>entry.includes("@napi-rs/canvas-linux-arm64-gnu")));
  assert.ok(includes?.[route]?.some((entry)=>entry.includes("@napi-rs/canvas-linux-arm64-musl")));
 }
});

test("signed PDF download URLs use a 60-second expiration and an exact object path",async()=>{
 const calls=[];
 const originalSupabaseUrl=process.env.SUPABASE_URL;
 process.env.SUPABASE_URL="https://storage.test";
 try {
  const input={ownerId:"owner",conversationId:"conversation",documentId:"document",contentType:"application/pdf"};
  const signedUrl="https://storage.test/storage/v1/object/sign/chat-documents/owner/conversation/document.pdf?token=secret-download-token";
  const db={storage:{from:(bucket)=>({createSignedUrl:async(path,expiration)=>{calls.push({bucket,path,expiration});return {data:{signedUrl},error:null};}})}};
  assert.equal(CHAT_DOCUMENT_DOWNLOAD_URL_EXPIRATION_SECONDS,60);
  assert.equal(await createSignedDocumentDownloadUrl(input,db),signedUrl);
  assert.deepEqual(calls,[{bucket:"chat-documents",path:"owner/conversation/document.pdf",expiration:CHAT_DOCUMENT_DOWNLOAD_URL_EXPIRATION_SECONDS}]);
  const invalidDb={storage:{from:()=>({createSignedUrl:async()=>({data:{signedUrl:"https://storage.test/storage/v1/object/sign/chat-documents/owner/conversation/document.pdf.backup?token=secret-download-token"},error:null})})}};
  await assert.rejects(createSignedDocumentDownloadUrl(input,invalidDb),(error)=>error instanceof ChatDocumentError&&error.code==="document_storage_invalid_url");
  const foreignDb={storage:{from:()=>({createSignedUrl:async()=>({data:{signedUrl:"https://attacker.test/storage/v1/object/sign/chat-documents/owner/conversation/document.pdf?token=secret-download-token"},error:null})})}};
  await assert.rejects(createSignedDocumentDownloadUrl(input,foreignDb),(error)=>error instanceof ChatDocumentError&&error.code==="document_storage_invalid_url");
 } finally {
  if(originalSupabaseUrl===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=originalSupabaseUrl;
 }
 });

test("finalize route keeps signed PDF URLs lazy on the native fast path",async()=>{
 const logs=[];
 const original=console.info;
 let ingestInput;
 console.info=(entry)=>logs.push(entry);
 try {
  const document={id:"document",name:"a.pdf",contentType:"application/pdf",size:8,pageCount:1,tokenEstimate:1,hasImages:false,imageCount:0,analyzedImageCount:0,imageAnalyses:[]};
  const handler=createFinalizeHandler({
   authorizeOwnerSession:async()=>({id:"owner"}),
   getServerClient:()=>({storage:{from:()=>({download:async()=>({data:new Blob(["%PDF-raw"]),error:null})})}}),
   ingestPdf:async(input)=>{ingestInput=input;return document;},
   ingestDocx:async()=>{throw Error("not called");},
  });
  const response=await handler(new Request("http://test",{method:"POST",headers:{authorization:"Bearer access-token", "content-type":"application/json"},body:JSON.stringify({conversationId:"conversation",documentId:"document",userMessageId:"message",jobId:"job",filename:"a.pdf",contentType:"application/pdf"})}));
  assert.equal(response.status,200);
  assert.equal(ingestInput.downloadUrl,undefined);
  assert.doesNotMatch(JSON.stringify(logs),/access-token/);
 } finally { console.info=original; }
});

test("finalize route redacts ingestion failures without a signed URL",async()=>{
 const logs=[];
 const original=console.info;
 console.info=(entry)=>logs.push(entry);
 try {
  const handler=createFinalizeHandler({
   authorizeOwnerSession:async()=>({id:"owner"}),
   getServerClient:()=>({storage:{from:()=>({download:async()=>({data:new Blob(["%PDF-raw"]),error:null})})}}),
   ingestPdf:async()=>{throw new ChatDocumentError("document_storage_invalid_url","signed URL contains secret-download-token",502);},
   ingestDocx:async()=>{throw Error("not called");},
  });
  const response=await handler(new Request("http://test",{method:"POST",headers:{authorization:"Bearer access-token", "content-type":"application/json"},body:JSON.stringify({conversationId:"conversation",documentId:"document",userMessageId:"message",jobId:"job",filename:"a.pdf",contentType:"application/pdf"})}));
  const payload=await response.json();
  assert.equal(response.status,502);
  assert.equal(payload.failedStage,"finalize-request");
  assert.equal(payload.error,"The document could not be finalized.");
  assert.doesNotMatch(JSON.stringify(payload),/secret-download-token|access-token/);
  assert.doesNotMatch(JSON.stringify(logs),/secret-download-token|access-token/);
 } finally { console.info=original; }
});

test("finalize route reports the failed Supabase download stage without exposing or logging credentials",async()=>{const logs=[];const original=console.info;console.info=(entry)=>logs.push(entry);try{const handler=createFinalizeHandler({authorizeOwnerSession:async()=>({id:"owner"}),getServerClient:()=>({storage:{from:()=>({download:async()=>{throw new Error("access-token=secret-token");}})}}),ingestPdf:async()=>{throw Error("not called")},ingestDocx:async()=>{throw Error("not called")}});const response=await handler(new Request("http://test",{method:"POST",headers:{authorization:"Bearer access-token", "content-type":"application/json"},body:JSON.stringify({conversationId:"conversation",documentId:"document",userMessageId:"message",jobId:"job",filename:"a.pdf",contentType:"application/pdf"})}));const payload=await response.json();assert.equal(response.status,502);assert.equal(payload.failedStage,"supabase-download");assert.equal(payload.error,"The document could not be downloaded.");assert.match(response.headers.get("Server-Timing"),/supabase-download;dur=/);assert.doesNotMatch(JSON.stringify(payload),/secret-token|access-token/);assert.doesNotMatch(JSON.stringify(logs),/secret-token|access-token/);}finally{console.info=original;}});
test("finalize route marks an uninstrumented failure as finalize-request",async()=>{const logs=[];const original=console.info;console.info=(entry)=>logs.push(entry);try{const handler=createFinalizeHandler({authorizeOwnerSession:async()=>({id:"owner"}),getServerClient:()=>({storage:{from:()=>({download:async()=>({data:new Blob(["%PDF-raw"]),error:null})})}}),ingestPdf:async()=>{throw new Error("provider response contains secret-token")},ingestDocx:async()=>{throw Error("not called")}});const response=await handler(new Request("http://test",{method:"POST",headers:{authorization:"Bearer access-token", "content-type":"application/json"},body:JSON.stringify({conversationId:"conversation",documentId:"document",userMessageId:"message",jobId:"job",filename:"a.pdf",contentType:"application/pdf"})}));const payload=await response.json();assert.equal(payload.failedStage,"finalize-request");assert.equal(payload.error,"The document could not be finalized.");assert.doesNotMatch(JSON.stringify(payload),/secret-token|access-token/);assert.doesNotMatch(JSON.stringify(logs),/secret-token|access-token/);}finally{console.info=original;}});
test("finalize route reports the external fallback stage when native parsing was recovered then failed",async()=>{const handler=createFinalizeHandler({authorizeOwnerSession:async()=>({id:"owner"}),getServerClient:()=>({storage:{from:()=>({download:async()=>({data:new Blob(["%PDF-raw"]),error:null})})}}),ingestPdf:async({timing})=>{timing.markFailed("native-parsing");timing.markFailed("external-parsing");throw new ChatDocumentError("parser_unavailable","provider unavailable",502);},ingestDocx:async()=>{throw Error("not called")}});const response=await handler(new Request("http://test",{method:"POST",headers:{authorization:"Bearer access-token", "content-type":"application/json"},body:JSON.stringify({conversationId:"conversation",documentId:"document",userMessageId:"message",jobId:"job",filename:"a.pdf",contentType:"application/pdf"})}));const payload=await response.json();assert.equal(payload.failedStage,"external-parsing");assert.equal(payload.error,"The external PDF parser could not prepare the document.");});
test("delete route removes the document through the authenticated store dependency",async()=>{const deleted=[];const handler=createDeleteHandler({authorizeOwnerSession:async(token)=>token==="access-token"?({id:"owner"}):null,deleteDocument:async(input)=>deleted.push(input)});const response=await handler(new Request("http://test",{method:"DELETE",headers:{authorization:"Bearer access-token","content-type":"application/json"},body:JSON.stringify({conversationId:"conversation",documentId:"document",contentType:"application/pdf"})}));assert.equal(response.status,200);assert.deepEqual(await response.json(),{deleted:true});assert.deepEqual(deleted,[{ownerId:"owner",conversationId:"conversation",documentId:"document",contentType:"application/pdf"}]);});
test("delete route rejects unauthorized and malformed cleanup requests",async()=>{const handler=createDeleteHandler({authorizeOwnerSession:async()=>null,deleteDocument:async()=>{throw Error("not called")}});const unauthorized=await handler(new Request("http://test",{method:"DELETE"}));assert.equal(unauthorized.status,401);const authorized=createDeleteHandler({authorizeOwnerSession:async()=>({id:"owner"}),deleteDocument:async()=>{throw Error("not called")}});const malformed=await authorized(new Request("http://test",{method:"DELETE",headers:{authorization:"Bearer access-token","content-type":"application/json"},body:JSON.stringify({conversationId:"conversation",documentId:"document",contentType:"text/plain"})}));assert.equal(malformed.status,400);});
