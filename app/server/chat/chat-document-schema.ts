import "server-only";

import { CHAT_DOCUMENT_BUCKET, DOCX_CONTENT_TYPE, ChatDocumentError } from "../../../lib/chat-document";
import { getServerClient } from "../../auth/supabase-server-adapter";

const SCHEMA_CACHE_MS = 5 * 60 * 1_000;
const DOCUMENT_COLUMNS = "has_images,image_count,analyzed_image_count,image_analyses";
const PAGE_COLUMNS = "extraction_method,failure";
const MESSAGE_COLUMNS = "documents";

let validUntil = 0;
let validation: Promise<void> | null = null;

async function validate(db: ReturnType<typeof getServerClient>): Promise<void> {
  const checks = await Promise.all([
    db.from("chat_documents").select(DOCUMENT_COLUMNS).limit(0),
    db.from("chat_document_pages").select(PAGE_COLUMNS).limit(0),
    db.from("chat_messages").select(MESSAGE_COLUMNS).limit(0),
  ]);
  const schemaError = checks.find(({ error }) => error)?.error;
  if (schemaError) throw schemaError;

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
          "The document database schema is not ready. Apply the document migrations and retry.",
          503,
        );
      })
      .finally(() => {
        validation = null;
      });
  }
  await validation;
}
