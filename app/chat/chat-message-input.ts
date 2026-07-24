import type {
  ChatAssistantRound,
  ChatMessageInput,
} from "../../lib/chat-protocol";
import type { AssistantActivity } from "./assistant-activity-types";

type TranscriptMessage = {
  role: "user" | "assistant";
  content: string;
  activities?: AssistantActivity[];
};

const INTERRUPTED_TOOL_RESULT_MESSAGE =
  "Python execution was interrupted before a result was returned.";

export function toChatMessageInput(
  message: TranscriptMessage,
): ChatMessageInput | null {
  const content = message.content.trim();
  if (!content) return null;
  if (message.role === "user" || !message.activities?.length) {
    return { role: message.role, content };
  }

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

    const result =
      activity.result ?? {
        id: activity.call.id,
        name: activity.call.name,
        ok: false,
        stdout: "",
        stderr: INTERRUPTED_TOOL_RESULT_MESSAGE,
      };
    round.toolCalls = [
      ...(round.toolCalls ?? []),
      {
        ...activity.call,
        result,
      },
    ];
  }

  if (!rounds.length) return { role: "assistant", content };

  const finalRound = rounds[rounds.length - 1];
  if (finalRound.toolCalls?.length) {
    rounds.push({ content });
  } else {
    finalRound.content = content;
  }

  return { role: "assistant", content, rounds };
}
