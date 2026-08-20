import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../auth/owner-auth-service";
import { parseUserQuestionAnswer } from "../../../../lib/user-question-protocol";
import { answerUserQuestionAndResume } from "../../../server/user-questions/user-question-service";
import { getUserQuestion } from "../../../server/user-questions/user-question-repository";

const unauthorized = () => NextResponse.json({ error: "Unauthorized." }, { status: 401 });

export async function GET(request: Request, context: { params: Promise<{ questionId: string }> }) {
  const user = await authorizeOwnerSession(request);
  if (!user) return unauthorized();
  const { questionId } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(questionId)) return NextResponse.json({ error: "Question ID is invalid." }, { status: 400 });
  try {
    const question = await getUserQuestion(user.id, questionId);
    if (!question) return NextResponse.json({ error: "Question not found." }, { status: 404 });
    return NextResponse.json({ question });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to load question." }, { status: 503 });
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ questionId: string }> }) {
  const user = await authorizeOwnerSession(request);
  if (!user) return unauthorized();
  const { questionId } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(questionId)) return NextResponse.json({ error: "Question ID is invalid." }, { status: 400 });
  try {
    const body = await request.json();
    const answer = parseUserQuestionAnswer(body);
    const result = await answerUserQuestionAndResume(user.id, questionId, answer);
    if (!result) return NextResponse.json({ error: "Question not found or already answered." }, { status: 404 });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to answer question." }, { status: error instanceof SyntaxError ? 400 : 422 });
  }
}
