import "server-only";

export type DiscordCommand = { requested: boolean; prompt: string };

export function parseDiscordCommand(content: string): DiscordCommand {
  const match = /^\/new(?:\s+([\s\S]*))?$/i.exec(content.trim());
  return match ? { requested: true, prompt: match[1]?.trim() ?? "" } : { requested: false, prompt: content.trim() };
}
