import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../../../auth/owner-auth-service";
import { getChatJob } from "../../../../../server/chat/chat-job-store";

export async function GET(request: Request, context: { params: Promise<{ conversationId: string; jobId: string }> }) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const user = await authorizeOwnerSession(authorization.slice(7));
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { conversationId, jobId } = await context.params;
  const after = Math.max(0, Number(new URL(request.url).searchParams.get("after") ?? 0) || 0);
  const job = await getChatJob(user.id, conversationId, jobId, after);
  return job ? NextResponse.json(job) : NextResponse.json({ error: "Job not found." }, { status: 404 });
}
