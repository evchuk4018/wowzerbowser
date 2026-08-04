import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = async (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("ODL document schema preserves metadata and cleans derived images independently", async () => {
 const [migration, store] = await Promise.all([
  source("database/migrations/010_open_data_loader_pdf.sql"),
  source("app/server/chat/chat-document-store.ts"),
 ]);
 assert.match(migration,/add column if not exists markdown text/);
 assert.match(migration,/add column if not exists provider_metadata jsonb/);
 assert.match(migration,/create table if not exists public\.chat_document_images/);
 assert.match(migration,/storage_object_id uuid/);
 assert.match(migration,/register_chat_document\(/);
 assert.match(migration,/page->>'markdown'/);
 assert.match(migration,/page->'providerMetadata'/);
 assert.match(store,/getAuthorizedDocumentImages/);
 assert.match(store,/from chat_document_images/);
 assert.match(store,/images\.storage_object_id/);
});
