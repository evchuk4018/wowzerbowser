import "server-only";

import { ChatImageError } from "../../../lib/chat-image";
import { ChatDocumentError, MAX_PDF_VISUAL_TRANSCRIPTION_PAGES } from "../../../lib/chat-document";
import { estimateUsageFromText } from "../../../lib/usage-pricing";
import { askOpenRouterAboutImage } from "../../providers/openrouter/openrouter-image-adapter";
import { OPENROUTER_QWEN_FLASH_MODEL } from "../../providers/openrouter/openrouter-config";
import { configuredVisionModel } from "./chat-model-catalog-service";
import { downloadAuthorizedDocumentBytes, getAuthorizedDocument } from "./chat-document-store";
import { pdfPageVisualPrompt } from "./document-page-visual-prompt";
import { renderPdfPage, renderPdfPagesSettled } from "./pdf-page-renderer";
import { transcribeRenderedPdfPage, type PdfPageVisualTranscription } from "./pdf-page-visual-transcription";
import { recordPromptUsage } from "../usage/prompt-cost-service";
import { runtimeConfigSnapshot } from "../config/runtime-config-service";

const MAX_SAFE_FOLLOWUP_QUESTION_CHARACTERS = 10_000;

export type InspectDocumentPageInput = {
  ownerId: string;
  conversationId: string;
  jobId?: string;
  documentId: string;
  pageNumber: number;
  question: string;
  toolCallId: string;
  signal?: AbortSignal;
};

export type InspectDocumentPageResult = {
  pageNumber: number;
  answer: string;
  model: string | null;
};

export type InspectDocumentPagesInput = {
  ownerId: string;
  conversationId: string;
  jobId?: string;
  documentId: string;
  pageNumbers: readonly number[];
  question: string;
  toolCallId: string;
  signal?: AbortSignal;
};

export type InspectDocumentPagesResult = {
  pages: Array<PdfPageVisualTranscription | { pageNumber: number; error: string }>;
};

const BATCH_CONCURRENCY = 3;

function validatePageNumbers(pageNumbers: readonly number[], pageCount: number): number[] {
  const unique = [...new Set(pageNumbers)];
  if (
    unique.length < 1
    || unique.length > MAX_PDF_VISUAL_TRANSCRIPTION_PAGES
    || unique.some((pageNumber) => !Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > pageCount)
  ) {
    throw new ChatDocumentError("invalid_page", `Select between 1 and ${MAX_PDF_VISUAL_TRANSCRIPTION_PAGES} pages within the document.`);
  }
  return unique.sort((left, right) => left - right);
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

export async function inspectDocumentPages(input: InspectDocumentPagesInput): Promise<InspectDocumentPagesResult> {
  const question = input.question.trim();
  const maxQuestionCharacters = Math.min(runtimeConfigSnapshot().imageFollowupMaxQuestionCharacters, MAX_SAFE_FOLLOWUP_QUESTION_CHARACTERS);
  if (!question || question.length > maxQuestionCharacters) {
    throw new ChatImageError("invalid_question", "The document page question is invalid.");
  }
  const bytes = await downloadAuthorizedDocumentBytes(input.ownerId, input.conversationId, input.documentId);
  if (!bytes) throw new ChatDocumentError("document_storage_invalid", "The PDF bytes are unavailable.", 404);
  const document = await getAuthorizedDocument(input.ownerId, input.conversationId, input.documentId);
  if (!document || document.contentType !== "application/pdf") throw new ChatDocumentError("document_storage_invalid", "The authorized document is not a PDF.", 400);
  const pageNumbers = validatePageNumbers(input.pageNumbers, document.pageCount);
  const rendered = await renderPdfPagesSettled(bytes, pageNumbers, { signal: input.signal, scale: 2 });
  const pages = await mapBounded(pageNumbers, BATCH_CONCURRENCY, async (pageNumber) => {
    const page = rendered.renderedPages.find((candidate) => candidate.pageNumber === pageNumber);
    const failure = rendered.failures.get(pageNumber);
    if (failure || !page) return { pageNumber, error: failure instanceof Error ? failure.message : "The page could not be rendered." };
    try {
      return await transcribeRenderedPdfPage({
        ownerId: input.ownerId,
        conversationId: input.conversationId,
        jobId: input.jobId,
        requestId: `${input.toolCallId}:pdf-page-${pageNumber}`,
        page,
        question,
        signal: input.signal,
      });
    } catch (error) {
      if (input.signal?.aborted) throw error;
      return { pageNumber, error: error instanceof Error ? error.message : "The page could not be transcribed." };
    }
  });
  return { pages };
}

export async function inspectDocumentPage(input: InspectDocumentPageInput): Promise<InspectDocumentPageResult> {
  const question = input.question.trim();
  const maxQuestionCharacters = Math.min(runtimeConfigSnapshot().imageFollowupMaxQuestionCharacters, MAX_SAFE_FOLLOWUP_QUESTION_CHARACTERS);
  if (!question || question.length > maxQuestionCharacters) {
    throw new ChatImageError("invalid_question", "The document page question is invalid.");
  }
  if (!Number.isSafeInteger(input.pageNumber) || input.pageNumber < 1) {
    throw new ChatDocumentError("invalid_page", "The requested document page is invalid.");
  }
  if (input.signal?.aborted) {
    throw new ChatDocumentError("parser_cancelled", "The document page inspection was cancelled.", 499);
  }

  const bytes = await downloadAuthorizedDocumentBytes(input.ownerId, input.conversationId, input.documentId);
  if (!bytes) throw new ChatDocumentError("document_storage_invalid", "The PDF bytes are unavailable.", 404);
  const rendered = await renderPdfPage(bytes, input.pageNumber, { signal: input.signal, scale: 1.5 });
  const answer = await askOpenRouterAboutImage(
    `${pdfPageVisualPrompt}\n\nQuestion: ${question}`,
    rendered.bytes,
    rendered.contentType,
    { signal: input.signal, model: await configuredVisionModel(input.ownerId).catch(() => null) },
  );
  await recordPromptUsage({
    ownerId: input.ownerId,
    provider: "openrouter",
    model: answer.model ?? OPENROUTER_QWEN_FLASH_MODEL,
    requestKind: "image_followup",
    requestId: `${input.toolCallId}:pdf-page`,
    round: 0,
    usage: answer.usage ?? estimateUsageFromText(`${pdfPageVisualPrompt}\n\nQuestion: ${question}`, answer.content),
    source: answer.usage || answer.exactCostUsd !== undefined ? "exact" : "estimated",
    conversationId: input.conversationId,
    jobId: input.jobId,
    exactCostUsd: answer.exactCostUsd,
  }).catch(() => undefined);
  return { pageNumber: input.pageNumber, answer: answer.content, model: answer.model };
}
