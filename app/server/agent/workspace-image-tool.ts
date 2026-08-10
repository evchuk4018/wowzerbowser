import "server-only";

import type { ChatToolCall, ChatToolResult } from "../../../lib/chat-protocol";
import { CHAT_IMAGE_CONTENT_TYPES, type ChatImageContentType, ChatImageError, validateChatImageBytes } from "../../../lib/chat-image";
import { workspaceContentType, workspacePath } from "../../../lib/workspace-protocol";
import { askOpenRouterAboutImage } from "../../providers/openrouter/openrouter-image-adapter";
import { OPENROUTER_QWEN_FLASH_MODEL } from "../../providers/openrouter/openrouter-config";
import { configuredVisionModel } from "../chat/chat-model-catalog-service";
import { recordPromptUsage } from "../usage/prompt-cost-service";
import { estimateUsageFromText } from "../../../lib/usage-pricing";
import { LocalPythonExecutor } from "../python/local-python-executor";
import { INSPECT_WORKSPACE_IMAGE_TOOL_NAME, configuredWorkspaceImageQuestionCharacters } from "./workspace-image-tool-manifest";

type WorkspaceImageToolContext = {
  ownerId: string;
  conversationId: string;
  jobId?: string;
  signal: AbortSignal;
  responseDeadlineAt: number;
  executor: LocalPythonExecutor;
};

type WorkspaceImageToolDependencies = {
  askOpenRouterAboutImage: typeof askOpenRouterAboutImage;
  configuredVisionModel: typeof configuredVisionModel;
  recordPromptUsage: typeof recordPromptUsage;
};

const DEFAULT_DEPENDENCIES: WorkspaceImageToolDependencies = {
  askOpenRouterAboutImage,
  configuredVisionModel,
  recordPromptUsage,
};

const WORKSPACE_IMAGE_PROMPT = "Answer the question using only visible evidence from the image. Do not guess; explicitly say when a requested detail is absent, obscured, unreadable, or uncertain.";

function parseArguments(call: ChatToolCall): { path: string; question: string } {
  let value: unknown;
  try { value = JSON.parse(call.arguments || "{}"); } catch { throw new ChatImageError("invalid_arguments", "The model returned invalid workspace image arguments."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ChatImageError("invalid_arguments", "Workspace image arguments must be an object.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "path" && key !== "question")) throw new ChatImageError("invalid_arguments", "Workspace image received an unexpected argument.");
  const path = typeof record.path === "string" ? workspacePath(record.path.trim()) : "";
  const question = typeof record.question === "string" ? record.question.trim() : "";
  if (!path) throw new ChatImageError("invalid_arguments", "Workspace image path is invalid.");
  if (!question || question.length > configuredWorkspaceImageQuestionCharacters()) throw new ChatImageError("invalid_question", "The workspace image question is invalid.");
  return { path, question };
}

function supportedContentType(value: string): value is ChatImageContentType {
  return (CHAT_IMAGE_CONTENT_TYPES as readonly string[]).includes(value);
}

export async function executeInspectWorkspaceImageTool(
  call: ChatToolCall,
  context: WorkspaceImageToolContext,
  dependencies: Partial<WorkspaceImageToolDependencies> = {},
): Promise<ChatToolResult> {
  const activeDependencies = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const startedAt = Date.now();
  try {
    if (call.name !== INSPECT_WORKSPACE_IMAGE_TOOL_NAME) throw new ChatImageError("invalid_tool", `Unknown workspace image tool: ${call.name}`);
    const args = parseArguments(call);
    if (/\.mp4$/iu.test(args.path)) throw new ChatImageError("unsupported_image", "MP4 files cannot be analyzed as images.");
    const contentType = workspaceContentType(args.path).split(";", 1)[0];
    if (!supportedContentType(contentType)) throw new ChatImageError("unsupported_image", "Only PNG, JPEG, WebP, and GIF workspace images can be analyzed.");
    const bytes = await context.executor.readWorkspaceFile(args.path);
    const detectedContentType = validateChatImageBytes(bytes, contentType);
    const prompt = `${WORKSPACE_IMAGE_PROMPT}\n\nQuestion: ${args.question}`;
    const deadline = AbortSignal.timeout(Math.max(0, context.responseDeadlineAt - Date.now()));
    const answer = await activeDependencies.askOpenRouterAboutImage(prompt, bytes, detectedContentType, {
      signal: AbortSignal.any([context.signal, deadline]),
      model: await activeDependencies.configuredVisionModel(context.ownerId).catch(() => null),
    });
    await activeDependencies.recordPromptUsage({
      ownerId: context.ownerId,
      provider: "openrouter",
      model: answer.model ?? OPENROUTER_QWEN_FLASH_MODEL,
      requestKind: "image_followup",
      requestId: `${call.id}:workspace-image`,
      round: 0,
      usage: answer.usage ?? estimateUsageFromText(prompt, answer.content),
      source: answer.usage || answer.exactCostUsd !== undefined ? "exact" : "estimated",
      conversationId: context.conversationId,
      jobId: context.jobId,
      exactCostUsd: answer.exactCostUsd,
    }).catch(() => undefined);
    return { id: call.id, name: call.name, ok: true, stdout: answer.content, stderr: "", durationMs: Date.now() - startedAt };
  } catch (error) {
    return {
      id: call.id,
      name: call.name,
      ok: false,
      stdout: "",
      stderr: error instanceof Error ? error.message : "Workspace image inspection failed.",
      durationMs: Date.now() - startedAt,
    };
  }
}

export { INSPECT_WORKSPACE_IMAGE_TOOL_DEFINITION } from "./workspace-image-tool-manifest";
