import {
  Client,
  GatewayIntentBits,
  Partials,
} from "discord.js";

const token = required("DISCORD_BOT_TOKEN");
const allowedUserId = required("DISCORD_ALLOWED_USER_ID");
const internalSecret = required("DISCORD_INTERNAL_SECRET");
const appUrl = new URL(required("NEXT_PUBLIC_SITE_URL")).origin;
const activeDeliveries = new Set();

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function headers(json = false) {
  return {
    authorization: `Bearer ${internalSecret}`,
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

async function appRequest(path, init = {}) {
  const response = await fetch(new URL(path, appUrl), {
    ...init,
    headers: { ...headers(Boolean(init.body)), ...init.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `App request failed (${response.status}).`);
  return body;
}

function conversationLink(conversationId) {
  return conversationId ? new URL(`/chat/${conversationId}`, appUrl).toString() : appUrl;
}

function splitResponse(content, link) {
  const suffix = `\n\nOpen in app: ${link}`;
  const finalLimit = 2_000 - suffix.length;
  let remaining = content?.trim() || "The assistant completed without a text response.";
  const chunks = [];
  while (remaining.length > finalLimit) {
    const window = remaining.slice(0, 2_000);
    const boundary = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
    const end = boundary >= 1_000 ? boundary : 2_000;
    chunks.push(remaining.slice(0, end).trimEnd());
    remaining = remaining.slice(end).trimStart();
  }
  chunks.push(`${remaining}${suffix}`);
  return chunks;
}

async function deliver(submission, fallbackMessage) {
  if (activeDeliveries.has(submission.messageId)) return;
  activeDeliveries.add(submission.messageId);
  try {
    let current = submission;
    while (current.status === "processing" || current.status === "running") {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      current = await appRequest(`/api/internal/discord/messages/${current.messageId}`);
    }
    const channel = fallbackMessage?.channel
      ?? await client.channels.fetch(current.channelId);
    if (!channel?.isTextBased()) throw new Error("Discord DM channel is unavailable.");
    const responseMessage = fallbackMessage?.id === current.responseMessageId
      ? fallbackMessage
      : await channel.messages.fetch(current.responseMessageId);
    if (fallbackMessage && fallbackMessage.id !== current.responseMessageId) {
      await fallbackMessage.delete().catch(() => undefined);
    }
    const content = current.status === "completed"
      ? current.output
      : `I couldn't complete that request: ${current.error || "Unknown error."}`;
    const chunks = splitResponse(content, conversationLink(current.conversationId));
    await responseMessage.edit({ content: chunks[0], allowedMentions: { parse: [] } });
    for (const chunk of chunks.slice(1)) {
      await channel.send({ content: chunk, allowedMentions: { parse: [] } });
    }
    await appRequest(`/api/internal/discord/messages/${current.messageId}`, {
      method: "PATCH",
      body: JSON.stringify({ delivered: true }),
    });
  } finally {
    activeDeliveries.delete(submission.messageId);
  }
}

const client = new Client({
  intents: [GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

client.on("messageCreate", async (message) => {
  if (message.author.bot || message.guildId || message.author.id !== allowedUserId) return;
  let placeholder;
  try {
    placeholder = await message.reply({
      content: "Working on it…",
      allowedMentions: { parse: [], repliedUser: false },
    });
    const submission = await appRequest("/api/internal/discord/messages", {
      method: "POST",
      body: JSON.stringify({
        messageId: message.id,
        channelId: message.channelId,
        userId: message.author.id,
        responseMessageId: placeholder.id,
        content: message.content,
        attachments: [...message.attachments.values()].map((attachment) => ({
          id: attachment.id,
          filename: attachment.name,
          contentType: attachment.contentType,
          size: attachment.size,
          url: attachment.url,
        })),
      }),
    });
    void deliver(submission, placeholder).catch((error) => {
      console.error({ event: "discord-delivery-failed", messageId: message.id, error: error.message });
    });
  } catch (error) {
    const content = `I couldn't submit that request: ${error instanceof Error ? error.message : "Unknown error."}`;
    if (placeholder) await placeholder.edit({ content, allowedMentions: { parse: [] } }).catch(() => undefined);
    else await message.reply({ content, allowedMentions: { parse: [], repliedUser: false } }).catch(() => undefined);
  }
});

client.once("ready", async () => {
  console.log(`Discord worker connected as ${client.user.tag}.`);
  try {
    const { submissions } = await appRequest("/api/internal/discord/messages");
    for (const submission of submissions ?? []) {
      void deliver(submission).catch((error) => {
        console.error({ event: "discord-recovery-failed", messageId: submission.messageId, error: error.message });
      });
    }
  } catch (error) {
    console.error({ event: "discord-recovery-list-failed", error: error instanceof Error ? error.message : String(error) });
  }
});

client.on("error", (error) => console.error({ event: "discord-client-error", error: error.message }));

await client.login(token);
