import "server-only";
import { completeOpenRouterQwenText } from "../../providers/openrouter/openrouter-qwen-text-adapter";
import { normalizeTodoList, type TodoItem, type TodoList } from "../../../lib/todo-protocol";
import { replaceTodoList } from "./chat-todo-store";

const TIMEOUT_MS = 20_000;
const SYSTEM = "Create a concise task plan. Return only strict JSON: {\"items\":[{\"id\":\"stable-kebab-id\",\"text\":\"objective\",\"status\":\"pending\"}]}. Use at most five items. Preserve completed items when still relevant. Do not include markdown.";

function parseItems(content: string): TodoItem[] {
  const parsed = JSON.parse(content) as unknown;
  return normalizeTodoList({ items: (parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).items : []) }).items;
}

export async function planTodos(input: {
  ownerId: string;
  conversationId: string;
  userMessage: string;
  previousAssistantOutput?: string;
  current: TodoList;
  signal?: AbortSignal;
  onUsage?: (answer: Awaited<ReturnType<typeof completeOpenRouterQwenText>>) => Promise<void>;
}): Promise<TodoList | null> {
  const prompt = [
    "<user-message>", input.userMessage.slice(0, 20_000), "</user-message>",
    "<previous-assistant-output>", (input.previousAssistantOutput ?? "(first turn)").slice(0, 20_000), "</previous-assistant-output>",
    "<current-todos>", JSON.stringify(input.current.items), "</current-todos>",
  ].join("\n");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const answer = await completeOpenRouterQwenText(prompt, { systemPrompt: SYSTEM, signal: input.signal, timeoutMs: TIMEOUT_MS, maxTokens: 500 });
      await input.onUsage?.(answer);
      return await replaceTodoList(input.ownerId, input.conversationId, parseItems(answer.content));
    } catch {
      if (attempt === 1 || input.signal?.aborted) return null;
    }
  }
  return null;
}
