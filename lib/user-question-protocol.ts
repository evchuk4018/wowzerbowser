export type UserQuestionStatus = "pending" | "answered" | "expired";

export type UserQuestion = {
  id: string;
  ownerId: string;
  source: "chat" | "automation";
  conversationId: string | null;
  chatJobId: string | null;
  automationRunId: string | null;
  opencodeSessionId: string | null;
  question: string;
  context: string | null;
  options: string[] | null;
  status: UserQuestionStatus;
  answer: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  answeredAt: string | null;
};

export function parseUserQuestionAnswer(value: unknown): string {
  if (!value || typeof value !== "object") throw new Error("Answer payload is invalid.");
  const record = value as Record<string, unknown>;
  const answer = typeof record.answer === "string" ? record.answer.trim() : "";
  if (!answer) throw new Error("answer is required.");
  if (answer.length > 4000) throw new Error("answer is too long.");
  return answer;
}
