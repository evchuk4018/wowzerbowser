import { existsSync, statSync, writeFileSync } from "node:fs";

const heartbeatFile = process.env.DISCORD_HEARTBEAT_FILE || "/tmp/wowzerbowser-discord-worker.heartbeat";
const heartbeatMaxAgeMs = boundedInteger(process.env.DISCORD_HEARTBEAT_MAX_AGE_MS, 90_000, 5_000, 300_000);

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

if (process.argv.includes("--health")) {
  try {
    if (!existsSync(heartbeatFile) || Date.now() - statSync(heartbeatFile).mtimeMs > heartbeatMaxAgeMs) process.exit(1);
    process.exit(0);
  } catch {
    process.exit(1);
  }
}

const { Client, GatewayIntentBits, Partials } = await import("discord.js");

const token = required("DISCORD_BOT_TOKEN");
const allowedUserId = required("DISCORD_ALLOWED_USER_ID");
const internalSecret = required("DISCORD_INTERNAL_SECRET");
const internalAppUrl = new URL(required("DISCORD_APP_URL")).origin;
const publicAppUrl = new URL(required("NEXT_PUBLIC_SITE_URL")).origin;
const activeDeliveries = new Set();
const activeAutomationDeliveries = new Set();
const activeUserQuestionDeliveries = new Set();
const AUTOMATION_POLL_INTERVAL_MS = 5_000;
const SUBMISSION_POLL_INTERVAL_MS = 5_000;
const USER_QUESTION_POLL_INTERVAL_MS = 5_000;
let heartbeatTimer;

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function safeError(error) {
  const value = error instanceof Error ? error.message : String(error);
  return value
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password|secret)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .slice(0, 500);
}

function writeHeartbeat() {
  try {
    writeFileSync(heartbeatFile, `${new Date().toISOString()}\n`, "utf8");
  } catch {
    // Health checks will fail if the status file cannot be updated.
  }
}

function headers(json = false) {
  return {
    authorization: `Bearer ${internalSecret}`,
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

async function appRequest(path, init = {}) {
  const response = await fetch(new URL(path, internalAppUrl), {
    ...init,
    headers: { ...headers(Boolean(init.body)), ...init.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `App request failed (${response.status}).`);
  return body;
}

function conversationLink(conversationId) {
  return conversationId ? new URL(`/chat/${conversationId}`, publicAppUrl).toString() : publicAppUrl;
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

async function acknowledgeAutomationDelivery(notificationId, result) {
  await appRequest(`/api/internal/discord/automation-notifications/${notificationId}`, {
    method: "PATCH",
    body: JSON.stringify(result),
  });
}

async function acknowledgeUserQuestionDelivery(notificationId, result) {
  await appRequest(`/api/internal/discord/user-question-notifications/${notificationId}`, {
    method: "PATCH",
    body: JSON.stringify(result),
  });
}

async function deliverUserQuestionNotification(notification) {
  if (activeUserQuestionDeliveries.has(notification.id)) return;
  activeUserQuestionDeliveries.add(notification.id);
  try {
    const user = await client.users.fetch(allowedUserId);
    const channel = await user.createDM();
    const question = notification.question.replaceAll("*", "\\*");
    const context = notification.context ? `\n\nContext: ${notification.context.replaceAll("*", "\\*")}` : "";
    const prompt = `**Bobert needs your input**\n\n${question}${context}\n\nReply to this message with your answer.`;
    const chunks = splitResponse(prompt, conversationLink(notification.conversationId));
    let firstMessage;
    for (const chunk of chunks) {
      const sent = await channel.send({ content: chunk, allowedMentions: { parse: [] } });
      firstMessage ??= sent;
    }
    await acknowledgeUserQuestionDelivery(notification.id, {
      status: "delivered",
      channelId: channel.id,
      messageId: firstMessage.id,
    });
  } catch (error) {
    const message = safeError(error);
    await acknowledgeUserQuestionDelivery(notification.id, {
      status: "failed",
      error: message,
    }).catch((ackError) => {
      console.error({ event: "discord-user-question-failure-ack-failed", notificationId: notification.id, error: safeError(ackError) });
    });
    throw error;
  } finally {
    activeUserQuestionDeliveries.delete(notification.id);
  }
}

async function pollUserQuestionNotifications() {
  try {
    const { notifications } = await appRequest("/api/internal/discord/user-question-notifications");
    await Promise.allSettled((notifications ?? []).map(async (notification) => {
      try { await deliverUserQuestionNotification(notification); } catch (error) {
        console.error({ event: "discord-user-question-delivery-failed", notificationId: notification.id, error: safeError(error) });
      }
    }));
  } catch (error) {
    console.error({ event: "discord-user-question-poll-failed", error: safeError(error) });
  }
}

async function tryAnswerPendingQuestion(message) {
  const content = message.content?.trim();
  if (!content) return false;
  if (content.startsWith("/") || content.toLowerCase() === "/new") return false;
  let questions = [];
  try {
    const body = await appRequest("/api/internal/user-questions");
    questions = body.questions ?? [];
  } catch { return false; }
  if (!questions.length) return false;
  const target = questions[0];
  try {
    await appRequest(`/api/internal/user-questions/${target.id}`, {
      method: "PATCH",
      body: JSON.stringify({ answer: content.slice(0, 4000) }),
    });
    await message.reply({
      content: `Got it — relayed your answer to the pending question:\n> ${target.question.slice(0, 500)}\n\nYour answer has been recorded and the paused run will resume shortly.`,
      allowedMentions: { parse: [], repliedUser: false },
    }).catch(() => undefined);
    return true;
  } catch (error) {
    console.error({ event: "discord-answer-pending-question-failed", questionId: target.id, error: safeError(error) });
    return false;
  }
}

async function deliverAutomationNotification(notification) {
  if (activeAutomationDeliveries.has(notification.id)) return;
  activeAutomationDeliveries.add(notification.id);
  try {
    const user = await client.users.fetch(allowedUserId);
    const channel = await user.createDM();
    const title = notification.title.replaceAll("*", "\\*");
    const chunks = splitResponse(`**${title}**\n\n${notification.message}`, conversationLink(notification.conversationId));
    let firstMessage;
    for (const chunk of chunks) {
      const sent = await channel.send({ content: chunk, allowedMentions: { parse: [] } });
      firstMessage ??= sent;
    }
    await acknowledgeAutomationDelivery(notification.id, {
      status: "delivered",
      channelId: channel.id,
      messageId: firstMessage.id,
    });
  } catch (error) {
    const message = safeError(error);
    await acknowledgeAutomationDelivery(notification.id, {
      status: "failed",
      error: message,
    }).catch((acknowledgementError) => {
      console.error({
        event: "discord-automation-failure-acknowledgement-failed",
        notificationId: notification.id,
        error: safeError(acknowledgementError),
      });
    });
    throw error;
  } finally {
    activeAutomationDeliveries.delete(notification.id);
  }
}

async function pollAutomationNotifications() {
  try {
    const { notifications } = await appRequest("/api/internal/discord/automation-notifications");
    await Promise.allSettled((notifications ?? []).map(async (notification) => {
      try {
        await deliverAutomationNotification(notification);
      } catch (error) {
      console.error({
        event: "discord-automation-delivery-failed",
        notificationId: notification.id,
        error: safeError(error),
        });
      }
    }));
  } catch (error) {
    console.error({
      event: "discord-automation-poll-failed",
      error: safeError(error),
    });
  }
}

async function pollPendingSubmissions() {
  try {
    const { submissions } = await appRequest("/api/internal/discord/messages");
    await Promise.allSettled((submissions ?? []).map(async (submission) => {
      try {
        await deliver(submission);
      } catch (error) {
        console.error({ event: "discord-recovery-failed", messageId: submission.messageId, error: safeError(error) });
      }
    }));
  } catch (error) {
    console.error({ event: "discord-recovery-list-failed", error: safeError(error) });
  }
}

const client = new Client({
  intents: [GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

client.on("messageCreate", async (message) => {
  if (message.author.bot || message.guildId || message.author.id !== allowedUserId) return;
  try {
    const answered = await tryAnswerPendingQuestion(message);
    if (answered) return;
  } catch {}
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
      console.error({ event: "discord-delivery-failed", messageId: message.id, error: safeError(error) });
    });
  } catch (error) {
    const content = `I couldn't submit that request: ${safeError(error)}`;
    if (placeholder) await placeholder.edit({ content, allowedMentions: { parse: [] } }).catch(() => undefined);
    else await message.reply({ content, allowedMentions: { parse: [], repliedUser: false } }).catch(() => undefined);
  }
});

client.once("ready", async () => {
  writeHeartbeat();
  heartbeatTimer = setInterval(writeHeartbeat, Math.min(heartbeatMaxAgeMs / 3, 30_000));
  heartbeatTimer.unref();
  console.log(JSON.stringify({ event: "discord-worker-ready", user: client.user.tag, internalAppUrl, reconnectRecovery: true }));
  await pollPendingSubmissions();
  await pollAutomationNotifications();
  await pollUserQuestionNotifications();
  setInterval(() => {
    void pollPendingSubmissions();
  }, SUBMISSION_POLL_INTERVAL_MS).unref();
  setInterval(() => {
    void pollAutomationNotifications();
  }, AUTOMATION_POLL_INTERVAL_MS).unref();
  setInterval(() => {
    void pollUserQuestionNotifications();
  }, USER_QUESTION_POLL_INTERVAL_MS).unref();
});

client.on("error", (error) => console.error({ event: "discord-client-error", error: safeError(error) }));

await client.login(token);
