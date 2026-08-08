import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const callback = readFileSync(new URL("../app/api/connectors/callback/route.ts", import.meta.url), "utf8");
const workspace = readFileSync(new URL("../app/chat/chat-workspace.tsx", import.meta.url), "utf8");
const tools = readFileSync(new URL("../app/settings/tools-settings.tsx", import.meta.url), "utf8");

test("Gmail OAuth returns to the Tools settings section", () => {
  assert.match(callback, /integrationCallbackUrl\("\/chat"\)/);
  assert.match(callback, /connectorId === "gmail" \? "tools" : "connectors"/);
  assert.match(callback, /connectorStatus/);
});

test("OAuth return status is consumed and opens settings", () => {
  assert.match(workspace, /setSettingsOpen\(true\)/);
  assert.match(workspace, /setConnectorStatus\(returned\.status\)/);
  assert.match(workspace, /url\.searchParams\.delete\("connectorStatus"\)/);
});

test("Gmail OAuth failure points to the required API and permission", () => {
  assert.match(tools, /Gmail API is enabled/);
  assert.match(tools, /Gmail read-only access was approved/);
});
