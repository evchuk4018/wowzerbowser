import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../auth/owner-auth-service";
import { DeepSeekError, listDeepSeekModels } from "../../../providers/deepseek/deepseek-adapter";

export async function GET(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const user = await authorizeOwnerSession(authorization.slice(7));
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  try {
    return NextResponse.json({ models: await listDeepSeekModels() });
  } catch (error: unknown) {
    const status = error instanceof DeepSeekError ? error.status : 503;
    const message = error instanceof Error ? error.message : "DeepSeek is unavailable.";
    return NextResponse.json({ error: message }, { status });
  }
}
