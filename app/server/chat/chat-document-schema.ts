import "server-only";

import { CHAT_DOCUMENT_BUCKET, DOCX_CONTENT_TYPE, ChatDocumentError } from "../../../lib/chat-document";
import { getServerClient } from "../../auth/supabase-server-adapter";
import { assertChatDocumentTables } from "./chat-document-store";

const SCHEMA_CACHE_MS = 5 * 60 * 1_000;

let validUntil = 0;
let validation: Promise<void> | null = null;

async function validate(db: ReturnType<typeof getServerClient>): Promise<void> {
  await assertChatDocumentTables();
  const { data, error: bucketError } = await db.storage.getBucket(CHAT_DOCUMENT_BUCKET);
  if (bucketError || !data) throw bucketError ?? new Error("The document bucket was not found.");
  const allowedMimeTypes = data.allowed_mime_types ?? [];
  if (!allowedMimeTypes.includes("application/pdf") || !allowedMimeTypes.includes(DOCX_CONTENT_TYPE)) {
    throw new Error("The document bucket does not allow PDF and DOCX uploads.");
  }
}

export async function ensureChatDocumentSchema(
  db: ReturnType<typeof getServerClient> = getServerClient(),
): Promise<void> {
  if (Date.now() < validUntil) return;
  if (!validation) {
    validation = validate(db)
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
