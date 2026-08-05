export type ChatMode = "normal" | "deep_research";

export const CHAT_MODE_COMMANDS = [
  { mode: "deep_research" as const, command: "/deep-research", label: "Deep research", description: "Break the question into research topics, then investigate them with subagents." },
];

const DEEP_RESEARCH_COMMAND = /(^|\s+)\/deep-research(?=\s|$)/i;

export function parseChatModeCommand(value: string): { mode: ChatMode; content: string } {
  if (!DEEP_RESEARCH_COMMAND.test(value)) return { mode: "normal", content: value };
  return {
    mode: "deep_research",
    content: value.replace(DEEP_RESEARCH_COMMAND, "").trim(),
  };
}

export function chatModeCommandAtCaret(value: string, caretPosition = value.length): { start: number; end: number; query: string } | null {
  const beforeCaret = value.slice(0, caretPosition);
  const tokenStart = beforeCaret.search(/(?:^|\s)\/[^\s]*$/);
  if (tokenStart < 0) return null;
  const start = beforeCaret[tokenStart] === "/" ? tokenStart : tokenStart + 1;
  const end = caretPosition;
  if (end < value.length && !/\s/.test(value[end])) return null;
  return { start, end, query: value.slice(start, end).toLowerCase() };
}
