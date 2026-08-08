import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { parseAutomationMutation } from "../lib/automation-protocol.ts";
import { nextAutomationRun } from "../app/server/automations/automation-schedule.ts";
import { messageUnlocksAutomationTools } from "../app/server/agent/automation-tool-manifest.ts";
import { resolveAutomationAnswer } from "../app/server/automations/automation-answer.ts";
import { parseChatUserPreferences } from "../lib/chat-user-preferences.ts";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("automation mutations enforce timezone and the 15 minute minimum", () => {
  assert.throws(() => parseAutomationMutation({ name: "RAM", kind: "live_check", instructions: "Notify below $80", schedule: { kind: "interval", everyMinutes: 14 }, timeZone: "America/New_York" }), /15/);
  assert.equal(parseAutomationMutation({ name: "News", kind: "report", instructions: "Give me a news report", schedule: { kind: "daily", localTime: "09:00" }, timeZone: "America/New_York" }).timeZone, "America/New_York");
});

test("interval and timezone schedules calculate future UTC occurrences", () => {
  assert.equal(nextAutomationRun({ kind: "interval", everyMinutes: 15 }, "Etc/UTC", new Date("2026-07-29T12:00:00Z")).toISOString(), "2026-07-29T12:15:00.000Z");
  assert.equal(nextAutomationRun({ kind: "daily", localTime: "09:00" }, "America/New_York", new Date("2026-07-29T12:00:00Z")).toISOString(), "2026-07-29T13:00:00.000Z");
  assert.equal(nextAutomationRun({ kind: "weekdays", localTime: "09:00" }, "America/New_York", new Date("2026-07-31T14:00:00Z")).toISOString(), "2026-08-03T13:00:00.000Z");
});

test("persistence and dispatcher are owner scoped and leased", async () => {
  const [migration, repository, route] = await Promise.all([source("database/migrations/003_atomic_functions.sql"), source("app/server/automations/automation-repository.ts"), source("app/api/internal/automations/dispatch/route.ts")]);
  assert.match(migration, /for update skip locked/);
  assert.match(migration, /lease_expires_at/);
  assert.match(repository, /where owner_id=\$1/);
  assert.match(repository, /databaseOwnerId\(ownerId\)/);
  assert.match(route, /AUTOMATION_DISPATCH_SECRET/);
});

test("explicit automation requests expose tools while the matching skill remains available", async () => {
  const [service, skill, settings] = await Promise.all([source("app/chat/chat-server-service.ts"), source("app/server/skills/builtin-skills.ts"), source("app/settings/settings-modal.tsx")]);
  assert.match(service, /automationToolsUnlocked \? AUTOMATION_TOOL_DEFINITIONS : \[\]/);
  assert.match(service, /automationToolsUnlocked = automationKeywordUnlock/);
  assert.match(service, /message\.role === "user" && messageUnlocksAutomationTools\(message\.content\)/);
  assert.match(service, /builtinKey === AUTOMATION_SKILL_KEY/);
  assert.match(skill, /key: "manage-automations"/);
  assert.match(skill, /Use create_automation to create the requested schedule/);
  assert.match(settings, /id: "automations", label: "Automations"/);
  assert.doesNotMatch(settings, /id: "storage"/);
});

test("automation intent detection covers recurring reports without matching ordinary news requests", () => {
  assert.equal(messageUnlocksAutomationTools("Create an automation that runs every day at 12:30"), true);
  assert.equal(messageUnlocksAutomationTools("Schedule a weekly project rundown"), true);
  assert.equal(messageUnlocksAutomationTools("Give me today's news"), false);
});

test("live checks suppress false results and pause after a match", async () => {
  const runner = await source("app/server/automations/automation-runner.ts");
  assert.match(runner, /outcome: "no_match"/);
  assert.match(runner, /pause: automation\.kind === "live_check"/);
  assert.match(runner, /automation\.kind === "report" \? true : answer\.matched/);
  assert.match(runner, /chatAutomationDelivery\.deliver/);
  assert.match(runner, /queueDiscordAutomationDelivery/);
  assert.match(
    runner,
    /if \(!matched\) \{[\s\S]*?outcome: "no_match"[\s\S]*?return;[\s\S]*?\}[\s\S]*?queueDiscordAutomationDelivery/,
  );
});

test("automation answers prefer structured results and retain JSON compatibility", () => {
  assert.deepEqual(
    resolveAutomationAnswer(
      { matched: true, title: " Structured title ", message: " Structured message " },
      "ignored prose",
      "Fallback title",
    ),
    { matched: true, title: "Structured title", message: "Structured message" },
  );
  assert.deepEqual(
    resolveAutomationAnswer(null, '{"matched":true,"title":"JSON title","message":"JSON message"}', "Fallback title"),
    { matched: true, title: "JSON title", message: "JSON message" },
  );
  assert.deepEqual(
    resolveAutomationAnswer(null, '```json\n{"matched":false,"title":"Fenced title","message":"Fenced message"}\n```', "Fallback title"),
    { matched: false, title: "Fenced title", message: "Fenced message" },
  );
});

test("legacy automation reasoning preferences are ignored", () => {
  for (const value of [undefined, true, false, "yes"]) {
    const parsed = parseChatUserPreferences({ userPresence: "", automationThinking: value });
    assert.ok(parsed);
    assert.equal("automationThinking" in parsed, false);
  }
});

test("automation always uses medium private reasoning and delivers only the result", async () => {
  const [runner, delivery, history, settings] = await Promise.all([
    source("app/server/automations/automation-runner.ts"),
    source("app/server/automations/automation-delivery.ts"),
    source("app/server/chat/chat-history-store.ts"),
    source("app/settings/configurables-settings.tsx"),
  ]);
  assert.match(runner, /thinking: true/);
  assert.match(runner, /reasoningEffort: "medium"/);
  assert.doesNotMatch(runner, /preferences\.automationThinking|thinkingEnabled/);
  assert.doesNotMatch(delivery, /reasoning|thinkingEnabled/);
  assert.doesNotMatch(settings, /Automation reasoning|automationThinking/);
  const start = history.indexOf("export async function createCompletedAutomationConversation");
  const end = history.indexOf("\n/**", start);
  const automationConversation = history.slice(start, end);
  assert.doesNotMatch(automationConversation, /reasoning|thinkingEnabled/);
});

test("ordinary automation prose becomes a safe non-matching fallback", () => {
  const answer = resolveAutomationAnswer(null, "Based on my research, the project remains on schedule.", "Daily project report");
  assert.deepEqual(answer, {
    matched: false,
    title: "Daily project report",
    message: "Based on my research, the project remains on schedule.",
  });
  assert.equal(answer.matched, false, "live checks require an explicit structured match");
  assert.throws(
    () => resolveAutomationAnswer(null, " \n ", "Empty automation"),
    /no usable result/,
  );
});

test("Discord automation delivery is durable, leased, and idempotent per run", async () => {
  const [migration, repository] = await Promise.all([
    source("database/migrations/003_atomic_functions.sql"),
    source("app/server/discord/discord-automation-repository.ts"),
  ]);
  assert.match(migration, /for update skip locked/);
  assert.match(migration, /lease_expires_at/);
  const schema = await source("database/migrations/001_initial_schema.sql");
  assert.match(schema, /unique \(owner_id, automation_run_id\)/);
  assert.match(schema, /discord_automation_notifications/);
  assert.match(repository, /on conflict\(owner_id,automation_run_id\) do nothing/);
});
