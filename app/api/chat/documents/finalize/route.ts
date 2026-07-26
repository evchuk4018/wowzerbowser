import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../../auth/owner-auth-service";
import { CHAT_DOCUMENT_BUCKET, MAX_PDF_BYTES } from "../../../../../lib/chat-document";
import { getServerClient } from "../../../../auth/supabase-server-adapter";
import { documentStoragePath } from "../../../../server/chat/chat-document-store";
import { ingestPdf } from "../../../../server/chat/chat-document-service";

export function createFinalizeHandler(deps = { authorizeOwnerSession, getServerClient, ingestPdf }) { return async (request: Request) => {
 const auth=request.headers.get("authorization"); const owner=auth?.startsWith("Bearer ")?await deps.authorizeOwnerSession(auth.slice(7)):null; if(!owner)return NextResponse.json({error:"Unauthorized."},{status:401});
 const body=await request.json().catch(()=>null) as Record<string,unknown>|null; if(!body||typeof body.conversationId!=="string"||typeof body.pdfId!=="string"||typeof body.userMessageId!=="string"||typeof body.jobId!=="string"||typeof body.filename!=="string")return NextResponse.json({error:"Invalid PDF metadata."},{status:400});
 try { const path=documentStoragePath(owner.id,body.conversationId,body.pdfId); const {data,error}=await deps.getServerClient().storage.from(CHAT_DOCUMENT_BUCKET).download(path); if(error)throw error; const bytes=new Uint8Array(await data.arrayBuffer()); if(bytes.length>MAX_PDF_BYTES)return NextResponse.json({error:"PDFs must be 25 MiB or smaller."},{status:413}); const document=await deps.ingestPdf({ownerId:owner.id,conversationId:body.conversationId,pdfId:body.pdfId,filename:body.filename,bytes,userMessageId:body.userMessageId,jobId:body.jobId,alreadyUploaded:true}); return NextResponse.json({document}); } catch(error){return NextResponse.json({error:error instanceof Error?error.message:"The PDF could not be parsed."},{status:502});}
}; }
export const POST=createFinalizeHandler();
