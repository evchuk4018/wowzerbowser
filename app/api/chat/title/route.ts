import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../auth/owner-auth-service";
import { DeepSeekError } from "../../../providers/deepseek/deepseek-error";
import { generateDeepSeekTitle } from "../../../providers/deepseek/deepseek-title";

export async function POST(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ") || !await authorizeOwnerSession(authorization.slice(7))) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  try {
    const body = await request.json() as { firstTurn?: unknown };
    if (typeof body.firstTurn !== "string" || !body.firstTurn.trim() || body.firstTurn.length > 20_000) {
      return NextResponse.json({ error: "Invalid first turn." }, { status: 400 });
    }
    return NextResponse.json({ title: await generateDeepSeekTitle(body.firstTurn.trim()) });
  } catch (error) {
    const status = error instanceof DeepSeekError ? error.status : 503;
    return NextResponse.json({ error: "The chat could not be named." }, { status });
  }
}
