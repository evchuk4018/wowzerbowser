import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = async (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("transcript extraction keeps controlled transcript and prompt-action hooks", async () => {
  const [transcript, turn, actions] = await Promise.all([
    source("app/chat/chat-transcript.tsx"),
    source("app/chat/conversation-turn.tsx"),
    source("app/chat/message-actions.tsx"),
  ]);
  assert.match(transcript, /className=\"transcript\"/);
  assert.match(transcript, /className=\"empty-state\"/);
  assert.match(turn, /onContextMenu/);
  assert.match(turn, /onPointerDown/);
  assert.match(turn, /version-controls/);
  assert.match(turn, /AssistantActivityTimeline/);
  assert.match(actions, /role=\"menu\"/);
  assert.match(actions, /Share prompt/);
  assert.doesNotMatch(transcript, /legacy renderer/);
  assert.doesNotMatch(turn, /fetchChat/);
});

