import "server-only";

import type { ChatToolCall, ChatToolResult } from "../../../lib/chat-protocol";
import type { SkillDefinition } from "../../../lib/skill-protocol";
import { createOwnerSkill, updateOwnerSkill } from "../skills/skill-service";
import { READ_SKILL_TOOL_NAME, SKILL_TOOL_NAMES } from "./skill-tool-manifest";

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

export async function executeSkillMutationTool(call: ChatToolCall, ownerId: string): Promise<ChatToolResult> {
  try {
    const input = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
    let output: unknown;
    if (call.name === SKILL_TOOL_NAMES.create) output = await createOwnerSkill(ownerId, input);
    else if (call.name === SKILL_TOOL_NAMES.update) {
      const { skillId, ...values } = input;
      output = await updateOwnerSkill(ownerId, String(skillId ?? ""), values);
    } else return failure(call, `Unknown skill mutation tool: ${call.name}`);
    return { id: call.id, name: call.name, ok: true, stdout: JSON.stringify(output), stderr: "" };
  } catch (error) {
    return failure(call, error instanceof Error ? error.message : "Skill operation failed.");
  }
}
