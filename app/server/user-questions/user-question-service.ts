import "server-only";

import { databaseOwnerId, query } from "../database/database";
import { answerUserQuestion, expireUserQuestions, getUserQuestion, listPendingUserQuestions } from "./user-question-repository";
import { resumeChatJobAfterInput } from "../chat/chat-job-store";
import { expireAwaitingInputAutomationRuns, finishAwaitingInputAutomationRun } from "../automations/automation-repository";

export async function answerUserQuestionAndResume(ownerId: string, questionId: string, answer: string): Promise<{ questionId: string; resumedChatJobId: string | null; resumedAutomationRunId: string | null } | null> {
  const question = await getUserQuestion(ownerId, questionId);
  if (!question || question.status !== "pending") return null;
  const answered = await answerUserQuestion(ownerId, questionId, answer);
  if (!answered) return null;
  let resumedChatJobId: string | null = null;
  let resumedAutomationRunId: string | null = null;
  if (answered.chatJobId && answered.conversationId) {
    try {
      await resumeChatJobAfterInput(ownerId, answered.conversationId, answered.chatJobId, `[User answer to "${answered.question.slice(0, 200)}"]: ${answer}`);
      resumedChatJobId = answered.chatJobId;
    } catch {}
  }
  if (answered.automationRunId) {
    try {
      const finished = await finishAwaitingInputAutomationRun(answered.automationRunId, {
        ownerId,
        answer,
        question: answered.question,
      });
      if (finished) resumedAutomationRunId = answered.automationRunId;
    } catch {}
  }
  return { questionId, resumedChatJobId, resumedAutomationRunId };
}

export async function expireStaleUserQuestions(ownerId: string): Promise<number> {
  const expiredCount = await expireUserQuestions(ownerId);
  if (expiredCount) {
    await expireAwaitingInputAutomationRuns(ownerId).catch(() => undefined);
  } else {
    await expireAwaitingInputAutomationRuns(ownerId).catch(() => undefined);
  }
  return expiredCount;
}

export async function getPendingQuestions(ownerId: string): Promise<Awaited<ReturnType<typeof listPendingUserQuestions>>> {
  return listPendingUserQuestions(ownerId);
}
