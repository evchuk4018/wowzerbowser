import "server-only";

import type { ModelToolDefinition } from "../../../lib/model-tool-protocol";
import { HOMELAB_OPENCODE_TOOL_NAME, isHomelabOpencodeConfigured } from "../../../lib/homelab-opencode-protocol";

export { HOMELAB_OPENCODE_TOOL_NAME };

export const HOMELAB_OPENCODE_TOOL_DEFINITION: ModelToolDefinition = {
  type: "function",
  function: {
    name: HOMELAB_OPENCODE_TOOL_NAME,
    description: "Run an opencode CLI turn on the homelab host over SSH. Use for repository work, github operations, and arbitrary shell tasks on the homelab. The prompt is executed as `opencode run --format json --auto`. Pass sessionId to continue a previous session.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["prompt"],
      properties: {
        prompt: { type: "string", minLength: 1, maxLength: 12000, description: "Instruction for the homelab opencode agent." },
        sessionId: { type: "string", minLength: 1, maxLength: 128, description: "Existing session id to continue. Omit for a new session." },
        cwd: { type: "string", minLength: 1, maxLength: 256, description: "Relative working directory under the homelab workdir." },
        agent: { type: "string", minLength: 1, maxLength: 64, description: "Opencode agent to use." },
        model: { type: "string", minLength: 1, maxLength: 128, description: "Model override in provider/model form." },
      },
    },
  },
};

export function availableHomelabOpencodeTools(): ModelToolDefinition[] {
  return isHomelabOpencodeConfigured() ? [HOMELAB_OPENCODE_TOOL_DEFINITION] : [];
}
