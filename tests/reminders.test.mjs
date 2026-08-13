import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  parseAutomationMutation,
  parseAutomationSchedule,
} from "../lib/automation-protocol.ts";
import {
  DEFAULT_CHAT_SYSTEM_PROMPT,
  parseChatRequest,
} from "../lib/chat-protocol.ts";
import {
  AUTOMATION_TOOL_DEFINITIONS,
  messageUnlocksAutomationTools,
  reminderInstructionsFor,
  REMINDER_TOOL_NAMES,
} from "../app/server/agent/automation-tool-manifest.ts";
import { runClaimedAutomation } from "../app/server/automations/automation-runner.ts";
import {
  nextAutomationRun,
  reminderTimeInUtc,
} from "../app/server/automations/automation-schedule.ts";
import { parseReminderMutation, reminderFromAutomation } from "../lib/reminder-protocol.ts";

async function source(relativePath) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

test("reminder input accepts a local one-off datetime and rejects recurring use", () => {
  assert.deepEqual(
    parseReminderMutation({
      title: "Pay rent",
      message: "Pay rent before leaving work.",
      at: "2026-08-14T15:00:45",
      timeZone: "America/New_York",
    }),
    {
      title: "Pay rent",
      message: "Pay rent before leaving work.",
      at: "2026-08-14T15:00",
      timeZone: "America/New_York",
    },
  );

  assert.throws(
    () => parseReminderMutation({ title: "Invalid", message: "x", at: "2026-02-30T15:00" }),
    /real calendar date/,
  );
  assert.throws(
    () =>
      parseAutomationMutation({
        name: "Not a reminder",
        kind: "report",
        instructions: "x",
        schedule: { kind: "once", at: "2026-08-14T15:00" },
      }),
    /Recurring automations cannot use a one-off schedule/,
  );
  assert.deepEqual(parseAutomationSchedule({ kind: "once", at: "2026-08-14T15:00" }), {
    kind: "once",
    at: "2026-08-14T15:00",
  });
});

test("one-off datetimes resolve in the user's timezone", () => {
  assert.equal(
    reminderTimeInUtc("2026-08-14T15:00", "America/New_York").toISOString(),
    "2026-08-14T19:00:00.000Z",
  );
  assert.equal(
    reminderTimeInUtc("2026-01-14T15:00", "America/New_York").toISOString(),
    "2026-01-14T20:00:00.000Z",
  );
  assert.equal(
    reminderTimeInUtc("2026-08-14T15:00-07:00", "America/New_York").toISOString(),
    "2026-08-14T22:00:00.000Z",
  );
  assert.throws(
    () => nextAutomationRun({ kind: "once", at: "2026-08-13T15:00" }, "America/New_York", new Date("2026-08-13T20:00:00.000Z")),
    /must be in the future/,
  );
});

test("chat requests preserve timezone and natural reminder language unlocks tools", () => {
  const request = parseChatRequest({
    messages: [{ role: "user", content: "Remind me tomorrow at 3 PM to call Alex." }],
    model: { provider: "openrouter", model: "test-model" },
    systemPrompt: DEFAULT_CHAT_SYSTEM_PROMPT,
    thinking: false,
    reasoningEffort: "low",
    userPresence: "active",
    timeZone: "America/New_York",
  });

  assert.equal(request.timeZone, "America/New_York");
  assert.equal(messageUnlocksAutomationTools("Remind me tomorrow at 3 PM to call Alex."), true);
  assert.match(reminderInstructionsFor("America/New_York"), /America\/New_York/);
  assert.match(reminderInstructionsFor("America/New_York"), /YYYY-MM-DDTHH:mm/);
  assert.throws(
    () =>
      parseChatRequest({
        messages: [{ role: "user", content: "hi" }],
        model: { provider: "openrouter", model: "test-model" },
        systemPrompt: DEFAULT_CHAT_SYSTEM_PROMPT,
        thinking: false,
        reasoningEffort: "low",
        userPresence: "active",
        timeZone: "Not/A_Timezone",
      }),
    /timeZone must be a valid IANA timezone/,
  );
});

function reminderAutomation(status = "active") {
  return {
    id: "reminder-1",
    ownerId: "owner-1",
    name: "Call Alex",
    kind: "reminder",
    instructions: "Call Alex about the appointment.",
    schedule: { kind: "once", at: "2026-08-14T15:00" },
    timeZone: "America/New_York",
    status,
    nextRunAt: "2026-08-14T19:00:00.000Z",
    lastRunAt: null,
    lastOutcome: null,
    lastError: null,
    consecutiveFailures: 0,
    createdAt: "2026-08-13T12:00:00.000Z",
    updatedAt: "2026-08-13T12:00:00.000Z",
  };
}

function claimedRun() {
  return {
    id: "run-1",
    automationId: "reminder-1",
    ownerId: "owner-1",
    scheduledFor: "2026-08-14T19:00:00.000Z",
    leaseToken: "lease-1",
    leaseExpiresAt: "2026-08-14T19:01:00.000Z",
    attempts: 1,
  };
}

test("the worker delivers a reminder verbatim and completes its one-off run", async () => {
  let delivered;
  let queued;
  let finished;
  let generated = false;

  const result = await runClaimedAutomation(claimedRun(), {
    getAutomation: async () => reminderAutomation(),
    generate: async () => {
      generated = true;
      throw new Error("reminders must not invoke the model");
    },
    deliver: {
      deliver: async (input) => {
        delivered = input;
        return { conversationId: undefined };
      },
    },
    queueDiscord: async (input) => {
      queued = input;
    },
    finish: async (_runId, input) => {
      finished = input;
      return true;
    },
    heartbeat: async () => true,
  });

  assert.equal(generated, false);
  assert.equal(result.outcome, "notified");
  assert.equal(delivered.message, "Call Alex about the appointment.");
  assert.equal(queued, undefined);
  assert.equal(finished.complete, true);
  assert.equal(finished.nextRunAt, null);
  assert.equal(finished.outcome, "notified");
});

test("a cancelled reminder is not delivered by the worker", async () => {
  let delivered = false;
  let finished;

  const result = await runClaimedAutomation(claimedRun(), {
    getAutomation: async () => reminderAutomation("cancelled"),
    deliver: {
      deliver: async () => {
        delivered = true;
        return {};
      },
    },
    finish: async (_runId, input) => {
      finished = input;
      return true;
    },
    heartbeat: async () => true,
  });

  assert.equal(result.outcome, "failed");
  assert.equal(delivered, false);
  assert.equal(finished.pause, true);
});

test("reminder lifecycle keeps completed and cancelled records visible", async () => {
  assert.equal(reminderFromAutomation(reminderAutomation("completed")).status, "completed");
  assert.equal(reminderFromAutomation(reminderAutomation("cancelled")).status, "cancelled");
  assert.equal(reminderFromAutomation(null), null);

  const repository = await source("app/server/automations/automation-repository.ts");
  const service = await source("app/server/reminders/reminder-service.ts");
  const migration = await source("database/migrations/025_one_off_reminders.sql");
  const route = await source("app/api/reminders/[reminderId]/route.ts");

  assert.match(repository, /kind='reminder'/);
  assert.match(repository, /status='cancelled'/);
  assert.match(repository, /complete\?: boolean/);
  assert.match(repository, /nextStatus/);
  assert.match(service, /name: values\.title/);
  assert.match(service, /const schedule = \{ kind: "once" as const, at: values\.at \}/);
  assert.match(service, /updateAutomationRow/);
  assert.match(migration, /'reminder'/);
  assert.match(migration, /'completed'/);
  assert.match(migration, /'cancelled'/);
  assert.match(route, /cancelReminder/);
});

test("reminder tools expose the view, edit, cancel, and create lifecycle", () => {
  assert.deepEqual(REMINDER_TOOL_NAMES, {
    list: "list_reminders",
    get: "get_reminder",
    create: "create_reminder",
    update: "update_reminder",
    cancel: "cancel_reminder",
  });
  for (const name of Object.values(REMINDER_TOOL_NAMES)) {
    assert.equal(AUTOMATION_TOOL_DEFINITIONS.some((definition) => definition.function.name === name), true);
  }
});
