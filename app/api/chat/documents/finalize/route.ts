import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../../auth/owner-auth-service";
import { CHAT_DOCUMENT_BUCKET, DOCUMENT_CONTENT_TYPES, MAX_PDF_BYTES } from "../../../../../lib/chat-document";
import { getServerClient } from "../../../../auth/supabase-server-adapter";
import { documentStoragePath } from "../../../../server/chat/chat-document-store";
import { ingestDocx, ingestPdf } from "../../../../server/chat/chat-document-service";

export function createFinalizeHandler(deps = { authorizeOwnerSession, getServerClient, ingestPdf, ingestDocx }) { return async (request: Request) => {
 const auth=request.headers.get("authorization"); const owner=auth?.startsWith("Bearer ")?await deps.authorizeOwnerSession(auth.slice(7)):null; if(!owner)return NextResponse.json({error:"Unauthorized."},{status:401});
 const body=await request.json().catch(()=>null) as Record<string,unknown>|null; if(!body||typeof body.conversationId!=="string"||typeof body.documentId!=="string"||typeof body.userMessageId!=="string"||typeof body.jobId!=="string"||typeof body.filename!=="string"||!DOCUMENT_CONTENT_TYPES.includes(body.contentType as never))return NextResponse.json({error:"Invalid document metadata."},{status:400});
 try { const contentType=body.contentType as (typeof DOCUMENT_CONTENT_TYPES)[number]; const path=documentStoragePath(owner.id,body.conversationId,body.documentId,contentType); const {data,error}=await deps.getServerClient().storage.from(CHAT_DOCUMENT_BUCKET).download(path); if(error)throw error; const bytes=new Uint8Array(await data.arrayBuffer()); if(bytes.length>MAX_PDF_BYTES)return NextResponse.json({error:"Documents must be 25 MiB or smaller."},{status:413}); const common={ownerId:owner.id,conversationId:body.conversationId,filename:body.filename,bytes,userMessageId:body.userMessageId,jobId:body.jobId,alreadyUploaded:true}; const document=contentType==="application/pdf"?await deps.ingestPdf({...common,pdfId:body.documentId}):await deps.ingestDocx({...common,documentId:body.documentId}); return NextResponse.json({document}); } catch(error){return NextResponse.json({error:error instanceof Error?error.message:"The document could not be parsed."},{status:502});}
}; }
export const POST=createFinalizeHandler();
