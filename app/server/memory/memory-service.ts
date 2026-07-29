import "server-only";

import type { MemoryView } from "../../../lib/memory-protocol";
import { listChatConversationSummaries } from "../chat/chat-summary-store";
import {
  deleteUserMemoryFromSettings,
  getUserMemoryTree,
  updateUserMemoryFromSettings,
  UserMemoryDuplicateError,
  UserMemoryNotFoundError,
} from "./user-memory-service";

export async function getMemoryView(ownerId: string): Promise<MemoryView> {
  const [profile, summaries] = await Promise.all([
    getUserMemoryTree(ownerId),
    listChatConversationSummaries(ownerId),
  ]);
  return { profile, summaries };
}

export {
  deleteUserMemoryFromSettings,
  updateUserMemoryFromSettings,
  UserMemoryDuplicateError,
  UserMemoryNotFoundError,
};
