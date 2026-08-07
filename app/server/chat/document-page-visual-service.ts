import "server-only";

import { ChatImageError } from "../../../lib/chat-image";
import { ChatDocumentError } from "../../../lib/chat-document";
import { estimateUsageFromText } from "../../../lib/usage-pricing";
import { askOpenRouterAboutImage } from "../../providers/openrouter/openrouter-image-adapter";
import { OPENROUTER_QWEN_FLASH_MODEL } from "../../providers/openrouter/openrouter-config";
import { configuredVisionModel } from "./chat-model-catalog-service";
import { downloadAuthorizedDocumentBytes } from "./chat-document-store";
import { pdfPageVisualPrompt } from "./document-page-visual-prompt";
import { renderPdfPage } from "./pdf-page-renderer";
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
