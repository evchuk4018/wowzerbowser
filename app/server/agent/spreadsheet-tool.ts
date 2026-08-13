import "server-only";

import type { ChatArtifact, ChatToolCall, ChatToolResult } from "../../../lib/chat-protocol";
import {
  isSpreadsheetContentType,
  parseSpreadsheetToolInput,
  SpreadsheetInputError,
  XLSX_CONTENT_TYPE,
  type SpreadsheetToolInput,
} from "../../../lib/spreadsheet-protocol";
import { workspaceFileFor } from "../../../lib/workspace-protocol";
import { registerArtifact } from "../artifacts/artifact-store";
import type { LocalPythonExecutor } from "../python/local-python-executor";
import { runOpenpyxlSpreadsheet, SpreadsheetProviderError } from "../../providers/openpyxl/openpyxl-spreadsheet-adapter";
import { SPREADSHEET_TOOL_NAME } from "./spreadsheet-tool-manifest";

export { SPREADSHEET_TOOL_DEFINITION, SPREADSHEET_TOOL_NAME } from "./spreadsheet-tool-manifest";

type SpreadsheetToolContext = {
  ownerId: string;
  conversationId: string;
  projectId?: string;
  executor: LocalPythonExecutor;
};

type SpreadsheetToolDependencies = {
  registerArtifact: typeof registerArtifact;
  runSpreadsheet: typeof runOpenpyxlSpreadsheet;
};

const DEFAULT_DEPENDENCIES: SpreadsheetToolDependencies = {
  registerArtifact,
  runSpreadsheet: runOpenpyxlSpreadsheet,
};

function failure(call: ChatToolCall, message: string, durationMs?: number): ChatToolResult {
  return {
    id: call.id,
    name: call.name,
    ok: false,
    stdout: "",
    stderr: message.slice(0, 2_000),
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}

function parseArguments(call: ChatToolCall): SpreadsheetToolInput {
  let value: unknown;
  try {
    value = JSON.parse(call.arguments || "{}");
  } catch {
    throw new SpreadsheetInputError("Spreadsheet arguments must be valid JSON.");
  }
  return parseSpreadsheetToolInput(value);
}

function artifactOutput(input: SpreadsheetToolInput, bytes: Uint8Array, context: SpreadsheetToolContext, dependencies: SpreadsheetToolDependencies): Promise<ChatArtifact> {
  const metadata = workspaceFileFor(input.path, bytes.byteLength);
  if (!isSpreadsheetContentType(metadata.contentType)) throw new SpreadsheetProviderError("The workbook metadata has an unexpected content type.");
  return dependencies.registerArtifact({
    ownerId: context.ownerId,
    conversationId: context.conversationId,
    chatProjectId: context.projectId,
    name: metadata.name,
    contentType: XLSX_CONTENT_TYPE,
    bytes,
    workspacePath: metadata.path,
    language: metadata.language,
    preview: "none",
    editable: false,
    origin: "generated",
  });
}

export async function executeSpreadsheetTool(
  call: ChatToolCall,
  context: SpreadsheetToolContext,
  dependencies: Partial<SpreadsheetToolDependencies> = {},
): Promise<ChatToolResult> {
  const startedAt = Date.now();
  if (call.name !== SPREADSHEET_TOOL_NAME) return failure(call, `Unknown spreadsheet tool: ${call.name}`, Date.now() - startedAt);
  const activeDependencies = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  try {
    const input = parseArguments(call);
    const result = await activeDependencies.runSpreadsheet(input, context.executor);
    if (input.operation === "read") {
      return {
        id: call.id,
        name: call.name,
        ok: true,
        stdout: JSON.stringify(result.summary),
        stderr: "",
        durationMs: Date.now() - startedAt,
      };
    }
    if (!result.bytes) throw new SpreadsheetProviderError("The spreadsheet provider did not return the workbook bytes.");
    const artifact = await artifactOutput(input, result.bytes, context, activeDependencies);
    return {
      id: call.id,
      name: call.name,
      ok: true,
      stdout: `${input.operation === "create" ? "Created" : "Updated"} ${input.path}.`,
      stderr: "",
      durationMs: Date.now() - startedAt,
      artifacts: [artifact],
    };
  } catch (error) {
    const message = error instanceof SpreadsheetInputError || error instanceof SpreadsheetProviderError
      ? error.message
      : error instanceof Error
        ? error.message
        : "Spreadsheet operation failed.";
    return failure(call, message, Date.now() - startedAt);
  }
}
