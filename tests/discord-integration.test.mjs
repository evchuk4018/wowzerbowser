import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DISCORD_MESSAGE_CONTENT_LIMIT,
  parseDiscordInboundMessage,
  splitDiscordMessage,
} from "../lib/discord-protocol.ts";

const validMessage = {
  messageId: "1234567890",
  channelId: "2234567890",
  userId: "3234567890",
  responseMessageId: "4234567890",
  content: "hello",
  attachments: [],
};

test("Discord inbound parsing accepts a private text prompt", () => {
  assert.deepEqual(parseDiscordInboundMessage(validMessage), validMessage);
});

test("Discord inbound parsing bounds attachments and restricts CDN origins", () => {
  assert.throws(() => parseDiscordInboundMessage({
    ...validMessage,
    attachments: [{
      id: "5234567890",
      filename: "notes.pdf",
      contentType: "application/pdf",
      size: 100,
      url: "https://example.com/notes.pdf",
    }],
  }), /Attachment URL is invalid/);

  assert.throws(() => parseDiscordInboundMessage({
    ...validMessage,
    attachments: Array.from({ length: 11 }, (_, index) => ({
      id: String(6000000000 + index),
      filename: "image.png",
      contentType: "image/png",
      size: 10,
      url: "https://cdn.discordapp.com/attachments/x/y/image.png",
    })),
  }), /at most 10 attachments/);
});

test("Discord responses are split within limits and link the final chunk", () => {
  const link = "https://wowzerbowser.vercel.app/chat/conversation-id";
  const chunks = splitDiscordMessage("word ".repeat(1_200), link);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= DISCORD_MESSAGE_CONTENT_LIMIT));
  assert.match(chunks.at(-1), /Open in app:/);
  assert.equal(chunks.slice(0, -1).some((chunk) => chunk.includes("Open in app:")), false);
});

test("Discord internal routes enforce server authentication and stay thin", async () => {
  const route = await readFile(new URL("../app/api/internal/discord/messages/route.ts", import.meta.url), "utf8");
  const statusRoute = await readFile(new URL("../app/api/internal/discord/messages/[messageId]/route.ts", import.meta.url), "utf8");
  assert.match(route, /authorizeDiscordInternalRequest/);
  assert.match(route, /submitDiscordMessage/);
  assert.match(route, /after\(/);
  assert.match(statusRoute, /authorizeDiscordInternalRequest/);
  assert.match(statusRoute, /discordSubmission/);
  assert.doesNotMatch(route, /getServerClient|runChatJob|fetch\(/);
});

test("Discord migration keeps mapping and idempotency state server-only", async () => {
  const migration = await readFile(new URL("../supabase/migrations/20260730150000_discord_dm_integration.sql", import.meta.url), "utf8");
  assert.match(migration, /primary key \(owner_id, discord_message_id\)/);
  assert.match(migration, /active_conversation_id/);
  assert.match(migration, /enable row level security/g);
  assert.doesNotMatch(migration, /create policy/i);
});
