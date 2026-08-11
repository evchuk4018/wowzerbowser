import type { ModelToolDefinition } from "../../../lib/model-tool-protocol";
import { MAX_PDF_VISUAL_TRANSCRIPTION_PAGES } from "../../../lib/chat-document";
import { WORKSPACE_LIMITS } from "../../../lib/workspace-protocol";
import { configuredWorkspaceImageQuestionCharacters } from "./workspace-image-tool-manifest";

export const INSPECT_WORKSPACE_PDF_TOOL_NAME = "inspect_workspace_pdf";

export function workspacePdfToolDefinition(): ModelToolDefinition {
  return {
    type: "function",
    function: {
      name: INSPECT_WORKSPACE_PDF_TOOL_NAME,
      description: "Render selected pages of a PDF in the persistent workspace and transcribe visible questions and mathematical formulas into verified structured data. Use this after downloading a PDF from Local Drive; do not write a custom PDF-rendering script.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["path", "pageNumbers", "question"],
        properties: {
          path: { type: "string", minLength: 1, maxLength: WORKSPACE_LIMITS.maxPathLength, description: "Safe relative workspace path to the PDF." },
          pageNumbers: { type: "array", minItems: 1, maxItems: MAX_PDF_VISUAL_TRANSCRIPTION_PAGES, items: { type: "integer", minimum: 1 } },
          question: { type: "string", minLength: 1, maxLength: configuredWorkspaceImageQuestionCharacters(), description: "What to transcribe or verify on each selected page." },
        },
      },
    },
  };
}

export const INSPECT_WORKSPACE_PDF_TOOL_DEFINITION = workspacePdfToolDefinition();

export function availableWorkspacePdfTools(enabled: boolean): ModelToolDefinition[] {
  return enabled ? [workspacePdfToolDefinition()] : [];
}
