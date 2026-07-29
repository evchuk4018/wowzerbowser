import "server-only";

import type { ChatToolCall, ChatToolResult } from "../../../lib/chat-protocol";
import type { SkillDefinition } from "../../../lib/skill-protocol";
import { READ_SKILL_TOOL_NAME } from "./skill-tool-manifest";

const failure = (call: ChatToolCall, message: string): ChatToolResult => ({
  id: call.id,
  name: call.name,
  ok: false,
  stdout: "",
  stderr: message,
});

export function executeReadSkillTool(
  call: ChatToolCall,
  skills: ReadonlyMap<string, SkillDefinition>,
): ChatToolResult {
  if (call.name !== READ_SKILL_TOOL_NAME) return failure(call, `Unknown skill tool: ${call.name}`);
  try {
    const input = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
    if (typeof input.skillId !== "string" || !input.skillId.trim()) {
      return failure(call, "skillId is required.");
    }
    const skill = skills.get(input.skillId.trim());
    if (!skill) return failure(call, "That skill is not available.");
    return {
      id: call.id,
      name: call.name,
      ok: true,
      stdout: JSON.stringify({
        id: skill.id,
        name: skill.name,
        summary: skill.summary,
        instructions: skill.instructions,
      }),
      stderr: "",
    };
  } catch {
    return failure(call, "Invalid read_skill arguments.");
  }
}
