import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../../../../auth/owner-auth-service";
import { cancelChatJob } from "../../../../../../server/chat/chat-job-store";

export async function POST(request: Request, context: { params: Promise<{ conversationId: string; jobId: string }> }) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const user = await authorizeOwnerSession(authorization.slice(7));
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { conversationId, jobId } = await context.params;
  return (await cancelChatJob(user.id, conversationId, jobId)) ? NextResponse.json({ jobId, status: "cancelled" }) : NextResponse.json({ error: "Job not found or already finished." }, { status: 404 });
}
