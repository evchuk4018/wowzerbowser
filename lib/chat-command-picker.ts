import { CHAT_MODE_COMMANDS } from "./chat-modes";

export const CHAT_PROJECT_COMMAND = {
  command: "/projects",
  label: "Projects",
  description: "Add this chat to a project",
} as const;

export const CHAT_COMPOSER_COMMANDS = [
  ...CHAT_MODE_COMMANDS,
  CHAT_PROJECT_COMMAND,
] as const;

export type ChatCommandToken = {
  start: number;
  end: number;
};

export function filterChatComposerCommands(query: string) {
  return CHAT_COMPOSER_COMMANDS.filter((item) => item.command.startsWith(query));
}

export function removeChatCommandToken(value: string, token: ChatCommandToken): string {
  return `${value.slice(0, token.start)}${value.slice(token.end)}`;
}

export function moveChatCommandIndex(current: number, direction: -1 | 1, count: number): number {
  if (count <= 0) return 0;
  return (current + direction + count) % count;
}
