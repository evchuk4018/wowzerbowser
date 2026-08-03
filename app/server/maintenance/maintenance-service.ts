import "server-only";

import { cleanupStaleEmptyChatConversations } from "../chat/chat-conversation-service";
import {
  cleanupExpiredChatImageUploads,
  listExpiredChatImageUploadConversations,
} from "../chat/chat-image-store";
import { cleanupAbandonedStorage } from "../storage/storage-service";

export const WORKER_MAINTENANCE_LIMIT = 50;
export const WORKER_MAINTENANCE_AGE_MS = 60 * 60 * 1_000;

function boundedLimit(value: number | undefined): number {
  return Number.isSafeInteger(value)
    ? Math.max(1, Math.min(value as number, WORKER_MAINTENANCE_LIMIT))
    : WORKER_MAINTENANCE_LIMIT;
}

export async function runStaleChatMaintenance(input: {
  ownerId: string;
  now?: Date;
  limit?: number;
  olderThanMs?: number;
}): Promise<number> {
  return cleanupStaleEmptyChatConversations(input.ownerId, {
    now: input.now,
    limit: boundedLimit(input.limit),
    maxAgeMs: Math.max(0, input.olderThanMs ?? 24 * 60 * 60 * 1_000),
  });
}

export async function runAbandonedUploadMaintenance(input: {
  ownerId: string;
  now?: Date;
  limit?: number;
}): Promise<number> {
  const now = input.now ?? new Date();
  const limit = boundedLimit(input.limit);
  const conversations = await listExpiredChatImageUploadConversations(input.ownerId, { now, limit });
  let cleaned = 0;
  for (const conversationId of conversations) {
    if (cleaned >= limit) break;
    cleaned += await cleanupExpiredChatImageUploads(input.ownerId, conversationId, { now, limit: Math.max(1, limit - cleaned) });
  }
  return Math.min(cleaned, limit);
}

export async function runIncompleteFileMaintenance(input: {
  ownerId: string;
  now?: Date;
  limit?: number;
  olderThanMs?: number;
}): Promise<number> {
  return cleanupAbandonedStorage({
    ownerId: input.ownerId,
    now: input.now,
    olderThanMs: input.olderThanMs ?? WORKER_MAINTENANCE_AGE_MS,
    limit: boundedLimit(input.limit),
  });
}
