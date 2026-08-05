import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = async (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("transcript extraction keeps controlled transcript and prompt-action hooks", async () => {
  const [transcript, turn, actions, workspace] = await Promise.all([
    source("app/chat/chat-transcript.tsx"),
    source("app/chat/conversation-turn.tsx"),
    source("app/chat/message-actions.tsx"),
    source("app/chat/chat-workspace.tsx"),
  ]);
  assert.match(transcript, /className=\"transcript\"/);
  assert.match(transcript, /className=\"empty-state\"/);
  assert.match(turn, /onContextMenu/);
  assert.match(turn, /onPointerDown/);
  assert.match(turn, /className=\{`message-bubble \$\{hasUserAttachments \? "message-bubble--with-attachments" : ""\}`\}[\s\S]*onContextMenu=\{handleContextMenu\}/);
  assert.match(turn, /className=\{`message-pair \$\{actionsOpen \? "message-actions-open" : ""\}`\}>\s*<div className="message-user-container">/);
  assert.doesNotMatch(turn, /className=\{`message-pair \$\{actionsOpen \? "message-actions-open" : ""\}`\}[^>]*on(?:ContextMenu|PointerDown)/);
  assert.match(turn, /version-controls/);
  assert.match(turn, /response-controls/);
  assert.match(turn, /"Copy response"/);
  assert.match(turn, /disabled=\{isStreamingConversation \|\| !assistantMessage\.content\}/);
  assert.match(turn, /aria-label="Retry this response"/);
  assert.match(turn, /className="response-tps"/);
  assert.match(turn, /className="response-cost"/);
  assert.match(turn, /streamMetrics\.runCost/);
  assert.match(turn, /outputTps\.toFixed\(1\)/);
  assert.match(turn, /aria-label="Response versions"/);
  assert.match(turn, /AssistantActivityTimeline/);
  assert.match(workspace, /version\.user\.attachments/);
  assert.match(workspace, /version\.user\.documents/);
  assert.match(workspace, /getActiveConversationTurns/);
  assert.match(workspace, /turns=\{activeTurns\}/);
  assert.match(actions, /role=\"menu\"/);
  assert.match(actions, /Share prompt/);
  assert.doesNotMatch(transcript, /legacy renderer/);
});
