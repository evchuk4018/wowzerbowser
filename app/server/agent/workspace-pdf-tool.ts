import "server-only";

import type { ChatToolCall, ChatToolResult } from "../../../lib/chat-protocol";
import { ChatDocumentError, MAX_PDF_VISUAL_TRANSCRIPTION_PAGES } from "../../../lib/chat-document";
import { workspacePath } from "../../../lib/workspace-protocol";
import { renderPdfPagesSettled } from "../chat/pdf-page-renderer";
import { transcribeRenderedPdfPage } from "../chat/pdf-page-visual-transcription";
import { configuredWorkspaceImageQuestionCharacters } from "./workspace-image-tool-manifest";
import { INSPECT_WORKSPACE_PDF_TOOL_NAME } from "./workspace-pdf-tool-manifest";

const TRANSCRIPTION_CONCURRENCY = 3;

type WorkspaceReader = { readWorkspaceFile: (path: string) => Promise<Uint8Array> };

export type WorkspacePdfToolContext = {
  ownerId: string;
  conversationId: string;
  jobId?: string;
  signal: AbortSignal;
  responseDeadlineAt: number;
  executor: WorkspaceReader;
};

type Dependencies = {
  transcribeRenderedPdfPage: typeof transcribeRenderedPdfPage;
};

const DEFAULT_DEPENDENCIES: Dependencies = { transcribeRenderedPdfPage };

const failure = (call: ChatToolCall, message: string): ChatToolResult => ({
  id: call.id,
  name: call.name,
  ok: false,
  stdout: "",
  stderr: message.slice(0, 2_000),
});

function parseArguments(call: ChatToolCall): { path: string; pageNumbers: number[]; question: string } {
  let value: unknown;
  try { value = JSON.parse(call.arguments || "{}"); } catch { throw new Error("Workspace PDF arguments must be valid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Workspace PDF arguments must be an object.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["path", "pageNumbers", "question"].includes(key))) throw new Error("Workspace PDF received an unexpected argument.");
  const path = typeof record.path === "string" ? workspacePath(record.path.trim()) : "";
  if (!path || !/\.pdf$/iu.test(path)) throw new Error("path must identify a PDF workspace file.");
  if (!Array.isArray(record.pageNumbers) || record.pageNumbers.length < 1 || record.pageNumbers.length > MAX_PDF_VISUAL_TRANSCRIPTION_PAGES) throw new Error(`pageNumbers must contain between 1 and ${MAX_PDF_VISUAL_TRANSCRIPTION_PAGES} pages.`);
  const pageNumbers = [...new Set(record.pageNumbers)].map((pageNumber) => {
    if (!Number.isSafeInteger(pageNumber) || Number(pageNumber) < 1) throw new Error("pageNumbers must contain positive integers.");
    return Number(pageNumber);
  }).sort((left, right) => left - right);
  const question = typeof record.question === "string" ? record.question.trim() : "";
  if (!question || question.length > configuredWorkspaceImageQuestionCharacters()) throw new Error("question is invalid.");
  return { path, pageNumbers, question };
}

async function mapBounded<T, R>(items: readonly T[], concurrency: number, map: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await map(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

function isPdf(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 5 && new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-";
}

export async function executeInspectWorkspacePdfTool(
  call: ChatToolCall,
  context: WorkspacePdfToolContext,
  overrides: Partial<Dependencies> = {},
): Promise<ChatToolResult> {
  const startedAt = Date.now();
  try {
    if (call.name !== INSPECT_WORKSPACE_PDF_TOOL_NAME) throw new Error(`Unknown workspace PDF tool: ${call.name}`);
    const args = parseArguments(call);
    const bytes = await context.executor.readWorkspaceFile(args.path);
    if (!isPdf(bytes)) throw new ChatDocumentError("pdf_parser_failed", "The workspace file is not a valid PDF.");
    const deadline = AbortSignal.timeout(Math.max(0, context.responseDeadlineAt - Date.now()));
    const signal = AbortSignal.any([context.signal, deadline]);
    const rendered = await renderPdfPagesSettled(bytes, args.pageNumbers, { signal, scale: 2 });
    const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
    const pages = await mapBounded(args.pageNumbers, TRANSCRIPTION_CONCURRENCY, async (pageNumber) => {
      const page = rendered.renderedPages.find((candidate) => candidate.pageNumber === pageNumber);
      const renderFailure = rendered.failures.get(pageNumber);
      if (renderFailure || !page) return { pageNumber, error: renderFailure instanceof Error ? renderFailure.message : "The page could not be rendered." };
      try {
        return await dependencies.transcribeRenderedPdfPage({
          ownerId: context.ownerId,
          conversationId: context.conversationId,
          jobId: context.jobId,
          requestId: `${call.id}:workspace-pdf-page-${pageNumber}`,
          page,
          question: args.question,
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        return { pageNumber, error: error instanceof Error ? error.message : "The page could not be transcribed." };
      }
    });
    return {
      id: call.id,
      name: call.name,
      ok: true,
      stdout: JSON.stringify({ path: args.path, pages }),
      stderr: "",
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return failure(call, error instanceof Error ? error.message : "Workspace PDF inspection failed.");
  }
}

export { INSPECT_WORKSPACE_PDF_TOOL_NAME };
