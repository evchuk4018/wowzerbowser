import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { CHAT_SEARCH_MAX_QUERY_LENGTH } from "../lib/chat-search.ts";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("chat search contract is owner-scoped across title, summary, and raw messages", async () => {
  const migration = await source("supabase/migrations/20260728010000_chat_search.sql");
  assert.match(migration, /p_owner_id uuid/);
  assert.match(migration, /conversations\.owner_id = p_owner_id/);
  assert.match(migration, /chat_conversation_summaries/);
  assert.match(migration, /chat_messages/);
  assert.match(migration, /conversations\.title/);
  assert.match(migration, /searchable_text not like/);
  assert.match(migration, /order by conversation_text\.updated_at desc/);
  assert.match(migration, /grant execute .* service_role/);
});

test("search route validates the bounded query and keeps authorization at the route boundary", async () => {
  const route = await source("app/api/chat/search/route.ts");
  assert.match(route, /authorizeOwnerSession/);
  assert.match(route, /CHAT_SEARCH_MAX_QUERY_LENGTH/);
  assert.match(route, /query\.length > CHAT_SEARCH_MAX_QUERY_LENGTH/);
  assert.match(route, /searchChatConversations\(owner\.id, query\)/);
  assert.equal(CHAT_SEARCH_MAX_QUERY_LENGTH, 200);
});

test("search dialog supports debounced cancellation and accessible dismissal", async () => {
  const dialog = await source("app/chat/chat-search-dialog.tsx");
  assert.match(dialog, /SEARCH_DEBOUNCE_MS/);
  assert.match(dialog, /AbortController/);
  assert.match(dialog, /event\.key === \"Escape\"/);
  assert.match(dialog, /aria-modal=\"true\"/);
  assert.match(dialog, /onSelectConversation\(result\.id\)/);
});
