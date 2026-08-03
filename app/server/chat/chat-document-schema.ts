import "server-only";

import { ChatDocumentError } from "../../../lib/chat-document";
import { ensureApplicationStorageDirectories } from "../storage/local-filesystem-storage";
import { assertChatDocumentTables } from "./chat-document-store";

const SCHEMA_CACHE_MS = 5 * 60 * 1_000;

let validUntil = 0;
let validation: Promise<void> | null = null;

async function validate(): Promise<void> {
  await assertChatDocumentTables();
  await ensureApplicationStorageDirectories();
}

export async function ensureChatDocumentSchema(): Promise<void> {
  if (Date.now() < validUntil) return;
  if (!validation) {
    validation = validate()
      .then(() => {
        validUntil = Date.now() + SCHEMA_CACHE_MS;
      })
      .catch(() => {
        validUntil = 0;
        throw new ChatDocumentError(
          "document_schema_unavailable",
          "The document database schema is not ready. Run the local PostgreSQL migrations and retry.",
          503,
        );
      })
      .finally(() => {
        validation = null;
      });
  }
  await validation;
}
