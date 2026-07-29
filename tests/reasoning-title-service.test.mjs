import assert from "node:assert/strict";
import test from "node:test";
import { ReasoningTitleCoordinator } from "../app/server/chat/reasoning-title-service.ts";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("reasoning titles appear after the initial delay and refresh single-flight", async () => {
  const events = [];
  const prompts = [];
  let active = 0;
  let maxActive = 0;
  const coordinator = new ReasoningTitleCoordinator({
    signal: new AbortController().signal,
    emit: async (event) => { events.push(event); },
    firstDelayMs: 10,
    refreshDelayMs: 30,
    finalWaitMs: 100,
    summarizeQwen: async (prompt) => {
      prompts.push(prompt);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await wait(8);
      active -= 1;
      return { summary: prompts.length === 1 ? "Planning the PDF edit" : "Refining the PDF edit approach", provider: "openrouter", model: "qwen/qwen3.7-flash", usage: null };
    },
  });
  coordinator.append("First thought.");
  assert.equal(events.length, 0);
  await wait(40);
  assert.equal(events[0]?.summary, "Planning the PDF edit");
  coordinator.append(" More reasoning.");
  coordinator.append(" Even more reasoning.");
  await wait(55);
  assert.equal(events.at(-1)?.summary, "Refining the PDF edit approach");
  assert.match(prompts.at(-1), /First thought\. More reasoning\. Even more reasoning\./);
  assert.equal(maxActive, 1);
  coordinator.cancel();
});

test("reasoning titles use Qwen Flash directly", async () => {
  const events = [];
  let fallbackCalls = 0;
  const coordinator = new ReasoningTitleCoordinator({
    signal: new AbortController().signal,
    emit: async (event) => { events.push(event); },
    firstDelayMs: 1,
    finalWaitMs: 100,
    summarizeQwen: async () => {
      fallbackCalls += 1;
      return { summary: "Checking an alternate approach", provider: "openrouter", model: "qwen/qwen3.7-flash", usage: null };
    },
  });
  coordinator.append("Need another approach.");
  await wait(15);
  assert.equal(fallbackCalls, 1);
  assert.equal(events[0]?.summary, "Checking an alternate approach");
  coordinator.cancel();
});

test("phase breaks reset title input to the new phase", async () => {
  const prompts = [];
  const coordinator = new ReasoningTitleCoordinator({
    signal: new AbortController().signal,
    emit: async () => {},
    firstDelayMs: 100,
    finalWaitMs: 100,
    summarizeQwen: async (prompt) => {
      prompts.push(prompt);
      return { summary: "Reviewing the current phase", provider: "openrouter", model: "qwen/qwen3.7-flash", usage: null };
    },
  });
  coordinator.append("Old phase reasoning.");
  await coordinator.breakPhase(2);
  coordinator.append("New phase reasoning.");
  await coordinator.finish();
  assert.match(prompts[0], /Old phase reasoning/);
  assert.match(prompts.at(-1), /New phase reasoning/);
  assert.doesNotMatch(prompts.at(-1), /Old phase reasoning/);
});
