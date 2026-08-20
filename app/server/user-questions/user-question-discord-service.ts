import "server-only";

import { configuredOwner } from "../../auth/owner-auth-service";
import { listPendingUserQuestions } from "./user-question-repository";

export async function pendingUserQuestionsForDiscord() {
  const owner = await configuredOwner();
  const questions = await listPendingUserQuestions(owner.id);
  return questions.map((question) => ({
    id: question.id,
    question: question.question,
    context: question.context,
    conversationId: question.conversationId,
    createdAt: question.createdAt,
  }));
}
