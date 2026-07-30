import "server-only";

import { randomUUID } from "node:crypto";
import {
  DEFAULT_CHAT_MODELS,
  DEFAULT_CHAT_SYSTEM_PROMPT,
  type ChatRequest,
} from "../../../lib/chat-protocol";
import { getActiveConversationTurns, type ChatConversation, type ChatHistoryMessage } from "../../../lib/chat-history";
import { toChatMessageInput } from "../../../lib/chat-message-input";
import { DEFAULT_CHAT_MODEL_PREFERENCE } from "../../../lib/chat-model-preference";
import { DOCX_CONTENT_TYPE, type ChatDocumentAttachment } from "../../../lib/chat-document";
import type { DiscordInboundMessage, DiscordSubmission } from "../../../lib/discord-protocol";
import { configuredOwner } from "../../auth/owner-auth-service";
import { analyzeAndStoreChatImages } from "../chat/chat-image-service";
import { ingestDocx, ingestPdf } from "../chat/chat-document-service";
import { createOrGetChatJob, getChatJob } from "../chat/chat-job-store";
import { runChatJob } from "../chat/chat-job-runner";
import { getChatConversation } from "../chat/chat-history-store";
import { generateAndPersistChatTitle } from "../chat/chat-title-service";
import { processChatSummaryForCompletedJob } from "../chat/chat-summary-service";
import { getChatUserPreferences } from "../chat/chat-user-preferences-store";
import { processDreamingForCompletedJob } from "../memory/dreaming-service";
import { downloadDiscordAttachment } from "./discord-attachment-adapter";
import {
  activeDiscordConversation,
  claimDiscordMessage,
  getDiscordSubmission,
  listPendingDiscordSubmissions,
  markDiscordDelivered,
  setActiveDiscordConversation,
  updateDiscordSubmission,
} from "./discord-repository";

function allowedDiscordUser(): string {
  const value = process.env.DISCORD_ALLOWED_USER_ID?.trim();
  if (!value || !/^\d{1,24}$/.test(value)) throw new Error("DISCORD_ALLOWED_USER_ID is not configured.");
  return value;
}

function activeMessages(conversation: ChatConversation | null) {
  if (!conversation) return [];
  return getActiveConversationTurns(conversation).flatMap((turn) => {
    const version = turn.versions[turn.activeVersion];
    if (!version) return [];
    return [toChatMessageInput(version.user), toChatMessageInput(version.assistant)].filter(
      (message): message is NonNullable<ReturnType<typeof toChatMessageInput>> => message !== null,
    );
  });
}

function newCommand(content: string): { requested: boolean; prompt: string } {
  const match = /^\/new(?:\s+([\s\S]*))?$/i.exec(content.trim());
  return match ? { requested: true, prompt: match[1]?.trim() ?? "" } : { requested: false, prompt: content.trim() };
}

async function prepareAttachments(input: {
  ownerId: string;
  conversationId: string;
  userMessageId: string;
  jobId: string;
  message: DiscordInboundMessage;
}): Promise<{ images: Awaited<ReturnType<typeof analyzeAndStoreChatImages>>; documents: ChatDocumentAttachment[] }> {
  const downloaded = [];
  for (const attachment of input.message.attachments) {
    downloaded.push(await downloadDiscordAttachment(attachment));
  }
  const imageInputs = downloaded.filter((item) => item.kind === "image").map((item) => ({
    id: item.id,
    name: item.filename,
    declaredType: item.contentType,
    bytes: item.bytes,
  }));
  const images = imageInputs.length
    ? await analyzeAndStoreChatImages(input.ownerId, input.conversationId, input.userMessageId, imageInputs, { jobId: input.jobId })
    : [];
  const documents: ChatDocumentAttachment[] = [];
  for (const document of downloaded.filter((item) => item.kind === "document")) {
    if (document.contentType === "application/pdf") {
      documents.push(await ingestPdf({
        ownerId: input.ownerId,
        conversationId: input.conversationId,
        pdfId: document.id,
        filename: document.filename,
        bytes: document.bytes,
        userMessageId: input.userMessageId,
        jobId: input.jobId,
      }));
    } else if (document.contentType === DOCX_CONTENT_TYPE) {
      documents.push(await ingestDocx({
        ownerId: input.ownerId,
        conversationId: input.conversationId,
        documentId: document.id,
        filename: document.filename,
        bytes: document.bytes,
        userMessageId: input.userMessageId,
        jobId: input.jobId,
      }));
    }
  }
  return { images, documents };
}

async function executeDiscordMessage(ownerId: string, message: DiscordInboundMessage): Promise<void> {
  const command = newCommand(message.content);
  const existingConversationId = await activeDiscordConversation(ownerId, message.userId, message.channelId);
  const conversationId = command.requested || !existingConversationId ? randomUUID() : existingConversationId;
  await setActiveDiscordConversation(ownerId, message.userId, message.channelId, conversationId);
  if (command.requested && !command.prompt && !message.attachments.length) {
    await updateDiscordSubmission(ownerId, message.messageId, {
      conversationId,
      status: "completed",
      output: "Started a new conversation.",
    });
    return;
  }

  const jobId = randomUUID();
  const turnId = randomUUID();
  const versionId = randomUUID();
  const userMessageId = randomUUID();
  const assistantMessageId = randomUUID();
  const conversation = await getChatConversation(ownerId, conversationId);
  const turns = conversation ? getActiveConversationTurns(conversation) : [];
  const prompt = command.prompt || (message.attachments.length ? "Attachment added" : "");
  const prepared = await prepareAttachments({ ownerId, conversationId, userMessageId, jobId, message });
  const userMessage: ChatHistoryMessage = {
    id: userMessageId,
    role: "user",
    content: prompt,
    ...(prepared.images.length ? { attachments: prepared.images } : {}),
    ...(prepared.documents.length ? { documents: prepared.documents } : {}),
  };
  const preferences = await getChatUserPreferences(ownerId);
  const modelPreference = DEFAULT_CHAT_MODEL_PREFERENCE;
  const request: ChatRequest = {
    systemPrompt: DEFAULT_CHAT_SYSTEM_PROMPT,
    userPresence: preferences.userPresence,
    messages: [...activeMessages(conversation), toChatMessageInput(userMessage)!],
    model: modelPreference.model ?? DEFAULT_CHAT_MODELS[0].ref,
    thinking: modelPreference.thinking,
    reasoningEffort: modelPreference.reasoningEffort,
    contextMode: preferences.focusedContextEnabled ? "focused" : "full",
    conversationId,
    jobId,
    idempotencyKey: message.messageId,
    persistence: {
      turnId,
      versionId,
      userMessageId,
      assistantMessageId,
      turnIndex: turns.length,
      versionIndex: 0,
    },
  };
  const created = await createOrGetChatJob(ownerId, request);
  await updateDiscordSubmission(ownerId, message.messageId, {
    conversationId,
    jobId: created.jobId,
    status: "running",
  });
  const terminal = await runChatJob(ownerId, conversationId, created.jobId);
  const persisted = await getChatJob(ownerId, conversationId, created.jobId);
  const completed = terminal ?? persisted;
  if (!completed || completed.status !== "completed") {
    throw new Error(completed?.error || "Discord chat generation did not complete.");
  }
  await updateDiscordSubmission(ownerId, message.messageId, {
    status: "completed",
    output: completed.finalOutput ?? "",
  });
  if (!conversation?.turns.length) {
    await generateAndPersistChatTitle(ownerId, conversationId, prompt).catch(() => undefined);
  }
  await processChatSummaryForCompletedJob(ownerId, conversationId, created.jobId).catch(() => undefined);
  await processDreamingForCompletedJob(ownerId, conversationId, created.jobId).catch(() => undefined);
}

export async function submitDiscordMessage(message: DiscordInboundMessage): Promise<{
  submission: DiscordSubmission;
  completion: Promise<void> | null;
}> {
  if (message.userId !== allowedDiscordUser()) throw new Error("Discord user is not authorized.");
  const owner = await configuredOwner();
  const claimed = await claimDiscordMessage(owner.id, message);
  if (!claimed.claimed) return { submission: claimed.submission, completion: null };
  const completion = executeDiscordMessage(owner.id, message).catch(async (error) => {
    await updateDiscordSubmission(owner.id, message.messageId, {
      status: "failed",
      error: error instanceof Error ? error.message : "Discord chat failed.",
    }).catch(() => undefined);
  });
  return { submission: claimed.submission, completion };
}

export async function discordSubmission(messageId: string): Promise<DiscordSubmission | null> {
  const owner = await configuredOwner();
  const current = await getDiscordSubmission(owner.id, messageId);
  if (!current?.conversationId || !current.jobId || current.status !== "running") return current;
  const job = await getChatJob(owner.id, current.conversationId, current.jobId);
  if (!job || job.status === "queued" || job.status === "running") return current;
  const status = job.status === "completed" ? "completed" : "failed";
  await updateDiscordSubmission(owner.id, messageId, {
    status,
    output: job.finalOutput,
    error: job.error,
  });
  return { ...current, status, output: job.finalOutput, error: job.error };
}

export async function pendingDiscordSubmissions(): Promise<DiscordSubmission[]> {
  return listPendingDiscordSubmissions((await configuredOwner()).id);
}

export async function confirmDiscordDelivery(messageId: string): Promise<void> {
  await markDiscordDelivered((await configuredOwner()).id, messageId);
}
