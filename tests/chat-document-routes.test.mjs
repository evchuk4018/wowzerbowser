import test from "node:test";
import assert from "node:assert/strict";
import { createUploadUrlHandler } from "../app/api/chat/documents/upload-url/route.ts";
test("upload URL route rejects unauthorized calls without reading PDF bytes",async()=>{const handler=createUploadUrlHandler({authorizeOwnerSession:async()=>null,createSignedDocumentUpload:async()=>{throw Error("not called")}});const response=await handler(new Request("http://test",{method:"POST"}));assert.equal(response.status,401);});
