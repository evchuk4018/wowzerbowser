import "server-only";

import { runtimeConfigSnapshot } from "../config/runtime-config-service";

export const INSPECT_IMAGE_TOOL_NAME = "inspect_image";

const MAX_SAFE_FOLLOWUP_QUESTION_CHARACTERS = 10_000;

export function configuredImageFollowupMaxQuestionCharacters(): number {
  return Math.min(runtimeConfigSnapshot().imageFollowupMaxQuestionCharacters, MAX_SAFE_FOLLOWUP_QUESTION_CHARACTERS);
}

export function inspectImageToolDefinition() {
  return {
    type: "function" as const,
    function: {
      name: INSPECT_IMAGE_TOOL_NAME,
      description: "Ask a focused question about an image attached to the current conversation. Use this when the existing text and visual summaries do not contain enough information to answer the user accurately.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["imageId", "question"],
        properties: {
          imageId: { type: "string", minLength: 1, maxLength: 128, pattern: "^[a-zA-Z0-9_-]{1,128}$" },
          question: { type: "string", minLength: 1, maxLength: configuredImageFollowupMaxQuestionCharacters() },
        },
      },
    },
  } as const;
}

export const INSPECT_IMAGE_TOOL_DEFINITION = inspectImageToolDefinition();

export function availableImageTools(hasImage = true) {
  return hasImage ? [inspectImageToolDefinition()] : [];
}
