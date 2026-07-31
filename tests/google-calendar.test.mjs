import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

import {
  CALENDAR_SKILL_KEY,
  CALENDAR_TOOL_DEFINITIONS,
  CALENDAR_TOOL_NAMES,
  messageUnlocksCalendarTools,
} from "../app/server/agent/calendar-tool-manifest.ts";

const source = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("calendar keyword gating accepts supported whole-word spellings only", () => {
  for (const word of ["calendar", "CALENDAR", "calender", "caldner", "calnder"]) {
    assert.equal(messageUnlocksCalendarTools(`Please check my ${word}.`), true);
  }
  for (const text of ["calendars", "mycalendar", "calndered", "schedule an event"]) {
    assert.equal(messageUnlocksCalendarTools(text), false);
  }
});

test("calendar manifests expose the complete bounded event surface", () => {
  assert.equal(CALENDAR_SKILL_KEY, "manage-google-calendar");
  assert.deepEqual(CALENDAR_TOOL_DEFINITIONS.map((tool) => tool.function.name), Object.values(CALENDAR_TOOL_NAMES));
  const create = CALENDAR_TOOL_DEFINITIONS.find((tool) => tool.function.name === CALENDAR_TOOL_NAMES.create);
  assert.deepEqual(create.function.parameters.required, ["summary", "start", "end"]);
  assert.equal(create.function.parameters.additionalProperties, false);
});

test("chat orchestration gates calendar tools by keyword or successful skill read", () => {
  const chat = source("app/chat/chat-server-service.ts");
  assert.match(chat, /latestUserMessage.*role === "user"/);
  assert.match(chat, /calendarKeywordUnlock.*messageUnlocksCalendarTools\(latestUserMessage/);
  assert.match(chat, /calendarToolsUnlocked = calendarKeywordUnlock/);
  assert.match(chat, /builtinKey === CALENDAR_SKILL_KEY.*calendarToolsUnlocked = true/);
  assert.match(chat, /const calendarDefinitions = calendarToolsUnlocked \? CALENDAR_TOOL_DEFINITIONS : \[\]/);
  assert.match(chat, /For calendar requests, use list_calendar_events/);
  assert.match(chat, /executeCalendarTool\(call, ownerId\)/);
});

test("automation calendar instructions expose calendar tools without exposing them to unrelated runs", () => {
  const chat = source("app/chat/chat-server-service.ts");
  assert.match(chat, /const calendarKeywordUnlock = messageUnlocksCalendarTools\(latestUserMessage\?\.content \?\? ""\)/);
  assert.match(chat, /const calendarDefinitions = calendarToolsUnlocked \? CALENDAR_TOOL_DEFINITIONS : \[\]/);
  assert.doesNotMatch(chat, /const calendarKeywordUnlock = !automationExecution/);
  assert.doesNotMatch(chat, /const calendarDefinitions = !automationExecution/);
});

test("calendar credentials remain owner-scoped and server-only", () => {
  const migration = source("supabase/migrations/20260730140000_google_calendar_credentials.sql");
  const repository = source("app/server/calendar/google-calendar-repository.ts");
  assert.match(migration, /owner_id uuid primary key references auth\.users/);
  assert.match(migration, /enable row level security/);
  assert.match(repository, /\.eq\("owner_id", ownerId\)/);
  assert.doesNotMatch(repository, /NEXT_PUBLIC.*SECRET|console\.(?:log|info)/);
});

test("OAuth uses offline access, consent, state, and the event-only scope", () => {
  const oauth = source("app/server/calendar/google-calendar-oauth.ts");
  assert.match(oauth, /calendar\.events/);
  assert.match(oauth, /access_type: "offline"/);
  assert.match(oauth, /prompt: "consent"/);
  assert.match(oauth, /timingSafeEqual/);
});
