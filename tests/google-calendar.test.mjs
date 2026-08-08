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
  const migration = source("database/migrations/001_initial_schema.sql");
  const repository = source("app/server/calendar/google-calendar-repository.ts");
  assert.match(migration, /create table if not exists public\.google_calendar_credentials/);
  assert.match(migration, /owner_id uuid primary key/);
  assert.match(repository, /where owner_id=\$1/);
  assert.match(repository, /databaseOwnerId\(ownerId\)/);
  assert.doesNotMatch(repository, /NEXT_PUBLIC.*SECRET|console\.(?:log|info)/);
});

test("OAuth uses offline access, consent, state, and the event-only scope", () => {
  const oauth = source("app/server/calendar/google-calendar-oauth.ts");
  assert.match(oauth, /calendar\.events/);
  assert.match(oauth, /access_type: "offline"/);
  assert.match(oauth, /prompt: "consent"/);
  assert.match(oauth, /timingSafeEqual/);
});

test("Google OAuth state and token encryption stay bound to the configured local origin", async () => {
  const previous = {
    site: process.env.NEXT_PUBLIC_SITE_URL,
    state: process.env.GOOGLE_OAUTH_STATE_SECRET,
    token: process.env.GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY,
  };
  process.env.NEXT_PUBLIC_SITE_URL = "https://homelab.tail861ffd.ts.net";
  process.env.GOOGLE_OAUTH_STATE_SECRET = "state-secret-for-tests";
  process.env.GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
  try {
    const { createGoogleCalendarState, googleCalendarRedirectUri, verifyGoogleCalendarState } = await import("../app/server/calendar/google-calendar-oauth.ts");
    const { decryptCalendarToken, encryptCalendarToken } = await import("../app/server/calendar/google-calendar-crypto.ts");
    const state = createGoogleCalendarState("owner-1");
    assert.equal(googleCalendarRedirectUri(), "https://homelab.tail861ffd.ts.net/api/integrations/google-calendar/callback");
    assert.equal(verifyGoogleCalendarState(state.state, state.cookieValue), "owner-1");
    assert.equal(verifyGoogleCalendarState(`${state.state}x`, state.cookieValue), null);
    const encrypted = encryptCalendarToken("refresh-token-secret");
    assert.doesNotMatch(encrypted.ciphertext, /refresh-token-secret/);
    assert.equal(decryptCalendarToken(encrypted), "refresh-token-secret");
  } finally {
    if (previous.site === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
    else process.env.NEXT_PUBLIC_SITE_URL = previous.site;
    if (previous.state === undefined) delete process.env.GOOGLE_OAUTH_STATE_SECRET;
    else process.env.GOOGLE_OAUTH_STATE_SECRET = previous.state;
    if (previous.token === undefined) delete process.env.GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY;
    else process.env.GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY = previous.token;
  }
});

test("Google refresh and Calendar operations stay in the provider adapter", async () => {
  const previous = {
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  };
  process.env.GOOGLE_OAUTH_CLIENT_ID = "calendar-client-id";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "calendar-client-secret";
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    calls.push({ target, method: init.method ?? "GET" });
    if (target.includes("oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: "access-token" }), { status: 200 });
    if (init.method === "POST") return new Response(JSON.stringify({ id: "created", summary: "Created", start: { date: "2026-08-03" }, end: { date: "2026-08-04" } }), { status: 200 });
    if (init.method === "PATCH") return new Response(JSON.stringify({ id: "updated", summary: "Updated", start: { date: "2026-08-03" }, end: { date: "2026-08-04" } }), { status: 200 });
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    if (target.includes("/events/event-1")) return new Response(JSON.stringify({ id: "event-1", summary: "Event", start: { date: "2026-08-03" }, end: { date: "2026-08-04" } }), { status: 200 });
    return new Response(JSON.stringify({ items: [{ id: "event-1", summary: "Event", start: { date: "2026-08-03" }, end: { date: "2026-08-04" } }] }), { status: 200 });
  };
  try {
    const { refreshGoogleAccessToken } = await import("../app/server/calendar/google-calendar-oauth.ts");
    const { googleCreateEvent, googleDeleteEvent, googleGetEvent, googleListEvents, googleUpdateEvent } = await import("../app/server/calendar/google-calendar-adapter.ts");
    assert.equal(await refreshGoogleAccessToken("refresh-token"), "access-token");
    assert.equal((await googleListEvents("access-token", { timeMin: "2026-08-03T00:00:00Z", timeMax: "2026-08-04T00:00:00Z" }))[0].id, "event-1");
    assert.equal((await googleGetEvent("access-token", "event-1")).id, "event-1");
    assert.equal((await googleCreateEvent("access-token", { summary: "Created" })).id, "created");
    assert.equal((await googleUpdateEvent("access-token", "event-1", { summary: "Updated" })).id, "updated");
    await googleDeleteEvent("access-token", "event-1");
    assert.equal(calls.filter(({ target }) => target.includes("googleapis.com")).length, 6);
  } finally {
    globalThis.fetch = originalFetch;
    if (previous.clientId === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    else process.env.GOOGLE_OAUTH_CLIENT_ID = previous.clientId;
    if (previous.clientSecret === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    else process.env.GOOGLE_OAUTH_CLIENT_SECRET = previous.clientSecret;
  }
});
