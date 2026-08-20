import { NextResponse } from "next/server";
import { authorizeDiscordInternalRequest } from "../../../../server/discord/discord-auth";
import { parseUserQuestionAnswer } from "../../../../../lib/user-question-protocol";
import { answerUserQuestionAndResume } from "../../../../server/user-questions/user-question-service";

const unauthorized = () => NextResponse.json({ error: "Unauthorized." }, { status: 401 });

export async function PATCH(request: Request, context: { params: Promise<{ questionId: string }> }) {
  if (!authorizeDiscordInternalRequest(request)) return unauthorized();
  try {
    const { questionId } = await context.params;
    if (!/^[0-9a-f-]{36}$/i.test(questionId)) return NextResponse.json({ error: "Question ID is invalid." }, { status: 400 });
    const body = await request.json();
    const answer = parseUserQuestionAnswer(body);
    const { configuredOwner } = await import("../../../../auth/owner-auth-service");
    const owner = await configuredOwner();
    const result = await answerUserQuestionAndResume(owner.id, questionId, answer);
    if (!result) return NextResponse.json({ error: "Question not found or already answered." }, { status: 404 });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to answer question." }, { status: error instanceof SyntaxError ? 400 : 422 });
  }
}
