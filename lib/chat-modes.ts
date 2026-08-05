export type ChatMode = "normal" | "deep_research";

export const CHAT_MODE_COMMANDS = [
  { mode: "deep_research" as const, command: "/deep-research", label: "Deep research", description: "Break the question into research topics, then investigate them with subagents." },
];

export function parseChatModeCommand(value: string): { mode: ChatMode; content: string } {
  const match = value.match(/^\s*\/deep-research(?:\s+|$)([\s\S]*)$/i);
  return match ? { mode: "deep_research", content: match[1].trim() } : { mode: "normal", content: value };
}
