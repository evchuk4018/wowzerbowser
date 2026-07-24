import type { ChatAssistantRound, ChatRequest } from "../../../lib/chat-protocol";

export type DeepSeekMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      reasoning_content?: string;
      tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
    }
  | { role: "tool"; content: string; tool_call_id: string; name?: string };

export type DeepSeekMessageBuildOptions = {
  replayRounds?: readonly ChatAssistantRound[];
  systemInstructions?: readonly string[];
};

function appendAssistantRound(history: DeepSeekMessage[], round: ChatAssistantRound): void {
  const calls = round.toolCalls ?? [];
  history.push({
    role: "assistant",
    content: round.content || null,
    ...(round.reasoning ? { reasoning_content: round.reasoning } : {}),
    ...(calls.length
      ? {
          tool_calls: calls.map((call) => ({
            id: call.id,
            type: "function" as const,
            function: { name: call.name, arguments: call.arguments },
          })),
        }
      : {}),
  });
  for (const call of calls) {
    if (call.result) {
      history.push({
        role: "tool",
        content: JSON.stringify(call.result),
        tool_call_id: call.id,
        name: call.name,
      });
    }
  }
}

function appendChatMessage(history: DeepSeekMessage[], message: ChatRequest["messages"][number]): void {
  if (message.role === "assistant" && message.rounds?.length) {
    for (const round of message.rounds) appendAssistantRound(history, round);
    return;
  }
  if (message.role === "assistant") {
    appendAssistantRound(history, {
      content: message.content,
      ...(message.reasoning ? { reasoning: message.reasoning } : {}),
      ...(message.toolCalls?.length ? { toolCalls: message.toolCalls } : {}),
    });
    return;
  }
  history.push({ role: "user", content: message.content });
}

/**
 * Build the provider wire transcript from the shared chat protocol. Keeping
 * this conversion here prevents orchestration code from depending on
 * DeepSeek-specific roles and field names.
 */
export function buildDeepSeekMessages(
  request: ChatRequest,
  options: DeepSeekMessageBuildOptions = {},
): DeepSeekMessage[] {
  const history: DeepSeekMessage[] = [];
  for (const message of request.messages) appendChatMessage(history, message);
  for (const round of options.replayRounds ?? []) appendAssistantRound(history, round);
  return [
    { role: "system", content: request.systemPrompt },
    ...(request.userPresence ? [{ role: "system" as const, content: request.userPresence }] : []),
    ...(options.systemInstructions ?? [])
      .filter((instruction) => instruction.trim().length > 0)
      .map((content) => ({ role: "system" as const, content })),
    ...history,
  ];
}
