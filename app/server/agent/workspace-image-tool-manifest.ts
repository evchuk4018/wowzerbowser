import type { ModelToolDefinition } from "../../../lib/model-tool-protocol";
import { runtimeConfigSnapshot } from "../config/runtime-config-service";

export const INSPECT_WORKSPACE_IMAGE_TOOL_NAME = "inspect_workspace_image";
const MAX_SAFE_QUESTION_CHARACTERS = 10_000;

export function configuredWorkspaceImageQuestionCharacters(): number {
  return Math.min(runtimeConfigSnapshot().imageFollowupMaxQuestionCharacters, MAX_SAFE_QUESTION_CHARACTERS);
}

export function inspectWorkspaceImageToolDefinition(): ModelToolDefinition {
  return {
    type: "function",
    function: {
      name: INSPECT_WORKSPACE_IMAGE_TOOL_NAME,
      description: "Ask a focused question about a supported image file in the persistent conversation workspace. Use this after downloading an image from Local Drive; MP4 and other video files are not supported.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["path", "question"],
        properties: {
          path: { type: "string", minLength: 1, maxLength: 512, description: "Safe relative workspace path to a PNG, JPEG, WebP, or GIF file." },
          question: { type: "string", minLength: 1, maxLength: configuredWorkspaceImageQuestionCharacters() },
        },
      },
    },
  };
}

export const INSPECT_WORKSPACE_IMAGE_TOOL_DEFINITION = inspectWorkspaceImageToolDefinition();

export function availableWorkspaceImageTools(enabled: boolean): ModelToolDefinition[] {
  return enabled ? [inspectWorkspaceImageToolDefinition()] : [];
}
