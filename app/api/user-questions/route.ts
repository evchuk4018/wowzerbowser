import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../auth/owner-auth-service";
import { getPendingQuestions } from "../../server/user-questions/user-question-service";

const unauthorized = () => NextResponse.json({ error: "Unauthorized." }, { status: 401 });

export async function GET(request: Request) {
  const user = await authorizeOwnerSession(request);
  if (!user) return unauthorized();
  try {
    const questions = await getPendingQuestions(user.id);
    return NextResponse.json({ questions });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to load questions." }, { status: 503 });
  }
}
