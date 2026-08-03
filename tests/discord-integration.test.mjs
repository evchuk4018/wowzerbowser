import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DISCORD_MESSAGE_CONTENT_LIMIT,
  parseDiscordAutomationDeliveryResult,
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

test("Discord commands and attachment retries preserve bounded, stable input", async () => {
  const { parseDiscordCommand } = await import("../app/server/discord/discord-command.ts");
  const { downloadDiscordAttachment } = await import("../app/server/discord/discord-attachment-adapter.ts");
  assert.deepEqual(parseDiscordCommand("/new"), { requested: true, prompt: "" });
  assert.deepEqual(parseDiscordCommand("/NEW summarize this"), { requested: true, prompt: "summarize this" });
  assert.deepEqual(parseDiscordCommand("hello"), { requested: false, prompt: "hello" });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-length": "3" } });
  try {
    const downloaded = await downloadDiscordAttachment({
      id: "5234567890",
      filename: "photo.png",
      contentType: "image/png",
      size: 3,
      url: "https://cdn.discordapp.com/attachments/x/y/photo.png",
    });
    assert.equal(downloaded.id, "5234567890");
    assert.equal(downloaded.kind, "image");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Discord submission rejects an unauthorized user before persistence", async () => {
  const previous = process.env.DISCORD_ALLOWED_USER_ID;
  process.env.DISCORD_ALLOWED_USER_ID = validMessage.userId;
  try {
    const { submitDiscordMessage } = await import("../app/server/discord/discord-chat-service.ts");
    await assert.rejects(() => submitDiscordMessage({ ...validMessage, messageId: "5234567891", userId: "9234567890" }), /not authorized/);
  } finally {
    if (previous === undefined) delete process.env.DISCORD_ALLOWED_USER_ID;
    else process.env.DISCORD_ALLOWED_USER_ID = previous;
  }
});

test("Discord responses are split within limits and link the final chunk", () => {
  const link = "https://homelab.tail861ffd.ts.net/chat/conversation-id";
  const chunks = splitDiscordMessage("word ".repeat(1_200), link);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= DISCORD_MESSAGE_CONTENT_LIMIT));
  assert.match(chunks.at(-1), /Open in app:/);
  assert.equal(chunks.slice(0, -1).some((chunk) => chunk.includes("Open in app:")), false);
});

test("Discord automation delivery acknowledgements require valid message coordinates", () => {
  assert.deepEqual(parseDiscordAutomationDeliveryResult({
    status: "delivered",
    channelId: "1234567890",
    messageId: "2234567890",
  }), {
    status: "delivered",
    channelId: "1234567890",
    messageId: "2234567890",
  });
  assert.throws(() => parseDiscordAutomationDeliveryResult({
    status: "delivered",
    channelId: "not-a-channel",
    messageId: "2234567890",
  }), /Channel ID/);
});

test("Discord internal routes enforce server authentication and stay thin", async () => {
  const route = await readFile(new URL("../app/api/internal/discord/messages/route.ts", import.meta.url), "utf8");
  const statusRoute = await readFile(new URL("../app/api/internal/discord/messages/[messageId]/route.ts", import.meta.url), "utf8");
  const service = await readFile(new URL("../app/server/discord/discord-chat-service.ts", import.meta.url), "utf8");
  assert.match(route, /authorizeDiscordInternalRequest/);
  assert.match(route, /submitDiscordMessage/);
  assert.doesNotMatch(route, /after\(|runChatJob|generateChatResponse/);
  assert.match(statusRoute, /authorizeDiscordInternalRequest/);
  assert.match(statusRoute, /discordSubmission/);
  assert.doesNotMatch(route, /getServerClient|runChatJob|fetch\(/);
  assert.match(service, /processPendingDiscordMessage/);
  assert.match(service, /finishDiscordMessagePreparation/);
  assert.doesNotMatch(service, /runChatJob/);
});

test("Discord migration keeps mapping and idempotency state server-only", async () => {
  const [migration, integrationMigration] = await Promise.all([
    readFile(new URL("../database/migrations/001_initial_schema.sql", import.meta.url), "utf8"),
    readFile(new URL("../database/migrations/009_local_integration_state.sql", import.meta.url), "utf8"),
  ]);
  assert.match(migration, /primary key \(owner_id, discord_message_id\)/);
  assert.match(migration, /active_conversation_id/);
  assert.match(integrationMigration, /claim_pending_discord_messages/);
  assert.match(integrationMigration, /processing_lease_token/);
});

test("Discord worker proactively polls, opens a DM, and activates delivered conversations", async () => {
  const [worker, service, route] = await Promise.all([
    readFile(new URL("../scripts/discord-worker.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/server/discord/discord-automation-service.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/internal/discord/automation-notifications/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(worker, /DISCORD_APP_URL/);
  assert.match(worker, /internalAppUrl/);
  assert.match(worker, /SUBMISSION_POLL_INTERVAL_MS/);
  assert.match(worker, /client\.users\.fetch\(allowedUserId\)/);
  assert.match(worker, /user\.createDM\(\)/);
  assert.match(worker, /AUTOMATION_POLL_INTERVAL_MS/);
  assert.match(service, /setActiveDiscordConversation/);
  assert.match(route, /authorizeDiscordInternalRequest/);
  assert.doesNotMatch(route, /getServerClient|client\.users|createDM/);
});

test("Discord Gateway is optional and uses the local Compose network", async () => {
  const [compose, dockerfile, packageJson, worker] = await Promise.all([
    readFile(new URL("../compose.yaml", import.meta.url), "utf8"),
    readFile(new URL("../Dockerfile", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../scripts/background-worker.ts", import.meta.url), "utf8"),
  ]);
  assert.match(compose, /discord:/);
  assert.match(compose, /profiles:\s*\["discord"\]/);
  assert.match(compose, /DISCORD_APP_URL: http:\/\/web:3000/);
  assert.match(compose, /DISCORD_BOT_TOKEN: \$\{DISCORD_BOT_TOKEN:-\}/);
  assert.doesNotMatch(compose.slice(compose.indexOf("  discord:"), compose.indexOf("volumes:")), /env_file:/);
  assert.match(compose, /worker\/discord-worker\.mjs/);
  assert.match(compose, /entrypoint: \["node"\]/);
  const discordBlock = compose.slice(compose.indexOf("  discord:"), compose.indexOf("volumes:"));
  assert.doesNotMatch(discordBlock, /ports:/);
  assert.match(dockerfile, /build:discord-worker/);
  assert.match(dockerfile, /\.next\/worker \.\/worker/);
  assert.match(packageJson, /build:discord-worker[^\n]*--external:discord\.js/);
  assert.match(dockerfile, /node_modules\/discord\.js/);
  assert.match(dockerfile, /node_modules\/@discordjs/);
  assert.match(worker, /processPendingDiscordMessage/);
});
