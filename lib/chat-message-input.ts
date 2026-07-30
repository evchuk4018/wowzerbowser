import type { ChatAssistantRound, ChatMessageInput } from "./chat-protocol";
import type { ChatHistoryMessage } from "./chat-history";
import { imageContextForAttachment } from "./chat-image";

const INTERRUPTED_TOOL_RESULT_MESSAGE = "Python execution was interrupted before a result was returned.";

export function toChatMessageInput(message: Pick<ChatHistoryMessage, "role" | "content" | "attachments" | "documents" | "activities">): ChatMessageInput | null {
  const content = message.content.trim();
  if (!content) return null;
  if (message.role === "user") {
    const attachments = message.attachments ?? [];
    const imageContext = attachments.map(imageContextForAttachment).join("\n\n");
    return {
      role: "user",
      content: imageContext ? `${content}\n\n${imageContext}` : content,
      ...(attachments.length ? { attachments } : {}),
      ...(message.documents?.length ? { documents: message.documents } : {}),
    };
  }
  if (!message.activities?.length) return { role: "assistant", content };

  const rounds: ChatAssistantRound[] = [];
  const roundIndexes = new Map<number, number>();
  for (const activity of message.activities) {
    let roundIndex = roundIndexes.get(activity.round);
    if (roundIndex === undefined) {
      roundIndex = rounds.length;
      roundIndexes.set(activity.round, roundIndex);
      rounds.push({ content: "" });
    }
    const round = rounds[roundIndex];
    if (activity.kind === "reasoning") {
      round.reasoning = `${round.reasoning ?? ""}${activity.content}`;
      continue;
    }
    if (activity.kind === "phase_break") {
      round.toolCalls = [...(round.toolCalls ?? []), { ...activity.call, result: activity.result }];
      continue;
    }
    round.toolCalls = [...(round.toolCalls ?? []), {
      ...activity.call,
      result: activity.result ?? {
        id: activity.call.id,
        name: activity.call.name,
        ok: false,
        stdout: "",
        stderr: INTERRUPTED_TOOL_RESULT_MESSAGE,
      },
    }];
  }
  if (!rounds.length) return { role: "assistant", content };
  const finalRound = rounds[rounds.length - 1];
  if (finalRound.toolCalls?.length) rounds.push({ content });
  else finalRound.content = content;
  return { role: "assistant", content, rounds };
}
