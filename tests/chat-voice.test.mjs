import assert from "node:assert/strict";
import test from "node:test";
import { encodePcmWav } from "../app/chat/chat-voice-recorder.ts";
import {
  appendChatVoiceTranscript,
  CHAT_VOICE_CONTENT_TYPE,
  MAX_CHAT_VOICE_BYTES,
  validateChatVoiceBytes,
  ChatVoiceError,
} from "../lib/chat-voice.ts";
import {
  OPENROUTER_VOICE_MODELS,
  OPENROUTER_VOICE_TRANSCRIPTION_PROMPT,
  transcribeWithOpenRouter,
} from "../app/providers/openrouter/openrouter-voice-adapter.ts";
import { createChatVoiceTranscriptionHandler } from "../app/api/chat/transcribe/route.ts";
import { transcribeChatVoice } from "../app/server/chat/chat-voice-service.ts";

const originalKey = process.env.OPENROUTER_API_KEY;
process.env.OPENROUTER_API_KEY = "test-voice-key";

test.after(() => {
  if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalKey;
});

function validWav() {
  const bytes = new Uint8Array(46);
  bytes.set([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WAVE")]);
  const view = new DataView(bytes.buffer);
  view.setUint32(12, 0x666d7420, false);
  view.setUint32(16, 16, true);
  view.setUint32(36, 0x64617461, false);
  view.setUint32(40, 2, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8_000, true);
  view.setUint32(28, 16_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  return bytes;
}

test("voice transcript appends while preserving the existing draft", () => {
  assert.equal(appendChatVoiceTranscript("already typed", "spoken words"), "already typed\nspoken words");
  assert.equal(appendChatVoiceTranscript("already typed ", "spoken words"), "already typed spoken words");
  assert.equal(appendChatVoiceTranscript("", " spoken words "), "spoken words");
  assert.equal(appendChatVoiceTranscript("already typed", "  "), "already typed");
});

test("PCM WAV encoder writes a valid mono WAV", async () => {
  const blob = encodePcmWav([new Float32Array([0, 1, -1])], 8_000);
  assert.equal(blob.type, CHAT_VOICE_CONTENT_TYPE);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assert.equal(bytes.length, 50);
  assert.equal(Buffer.from(bytes.slice(0, 4)).toString(), "RIFF");
  assert.equal(Buffer.from(bytes.slice(8, 12)).toString(), "WAVE");
  assert.equal(new DataView(bytes.buffer).getUint16(22, true), 1);
  assert.equal(new DataView(bytes.buffer).getUint32(24, true), 8_000);
});

test("voice validation rejects empty, oversized, wrong-type, and malformed audio", () => {
  assert.throws(() => validateChatVoiceBytes(new Uint8Array()), (error) => error instanceof ChatVoiceError && error.code === "empty_audio");
  assert.throws(() => validateChatVoiceBytes(new Uint8Array(MAX_CHAT_VOICE_BYTES + 1)), (error) => error instanceof ChatVoiceError && error.code === "audio_too_large");
  assert.throws(() => validateChatVoiceBytes(validWav(), "audio/mp3"), (error) => error instanceof ChatVoiceError && error.code === "unsupported_audio");
  assert.throws(() => validateChatVoiceBytes(new Uint8Array([1, 2, 3]), CHAT_VOICE_CONTENT_TYPE), (error) => error instanceof ChatVoiceError && error.code === "invalid_audio");
  const tooLong = new Uint8Array(44 + 300);
  tooLong.set(validWav());
  const tooLongView = new DataView(tooLong.buffer);
  tooLongView.setUint32(24, 1, true);
  tooLongView.setUint32(40, 300, true);
  assert.throws(() => validateChatVoiceBytes(tooLong, CHAT_VOICE_CONTENT_TYPE), (error) => error instanceof ChatVoiceError && error.code === "audio_too_long");
  validateChatVoiceBytes(validWav(), CHAT_VOICE_CONTENT_TYPE);
});

test("OpenRouter voice adapter sends audio with the requested model fallback order", async () => {
  const calls = [];
  const answer = await transcribeWithOpenRouter(validWav(), {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({
        model: "mistralai/voxtral-small-24b-2507",
        choices: [{ message: { content: [{ type: "text", text: "spoken words" }] } }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7, cost: 0.0004 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(answer.transcript, "spoken words");
  assert.equal(answer.model, "mistralai/voxtral-small-24b-2507");
  assert.equal(answer.usage.totalTokens, 7);
  assert.equal(answer.exactCostUsd, 0.0004);
  assert.equal(calls[0].url, "https://openrouter.ai/api/v1/chat/completions");
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.models, OPENROUTER_VOICE_MODELS);
  assert.deepEqual(body.messages[0].content[0], { type: "text", text: OPENROUTER_VOICE_TRANSCRIPTION_PROMPT });
  assert.equal(body.messages[0].content[1].type, "input_audio");
  assert.equal(body.messages[0].content[1].input_audio.format, "wav");
  assert.equal(typeof body.messages[0].content[1].input_audio.data, "string");
  assert.equal(body.stream, false);
});

test("voice route authenticates, validates WAV input, and returns a transcript", async () => {
  const calls = [];
  const handler = createChatVoiceTranscriptionHandler({
    authorizeOwnerSession: async () => ({ id: "owner-1" }),
    transcribeChatVoice: async (...args) => {
      calls.push(args);
      return { transcript: "spoken words", model: "voice-model", usage: null };
    },
  });
  const response = await handler(new Request("http://localhost/api/chat/transcribe", {
    method: "POST",
    headers: { "content-type": CHAT_VOICE_CONTENT_TYPE },
    body: validWav(),
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { transcript: "spoken words", model: "voice-model" });
  assert.equal(calls[0][0], "owner-1");
  assert.deepEqual([...calls[0][1]], [...validWav()]);
});

test("voice route rejects unauthenticated, non-WAV, and oversized requests", async () => {
  const handler = createChatVoiceTranscriptionHandler({
    authorizeOwnerSession: async () => null,
    transcribeChatVoice: async () => { throw new Error("must not call"); },
  });
  const unauthorized = await handler(new Request("http://localhost/api/chat/transcribe", { method: "POST" }));
  assert.equal(unauthorized.status, 401);

  const authenticated = createChatVoiceTranscriptionHandler({
    authorizeOwnerSession: async () => ({ id: "owner-1" }),
    transcribeChatVoice: async () => { throw new Error("must not call"); },
  });
  const wrongType = await authenticated(new Request("http://localhost/api/chat/transcribe", {
    method: "POST",
    headers: { "content-type": "audio/webm" },
    body: new Uint8Array([1]),
  }));
  assert.equal(wrongType.status, 400);
  const oversized = await authenticated(new Request("http://localhost/api/chat/transcribe", {
    method: "POST",
    headers: { "content-type": CHAT_VOICE_CONTENT_TYPE, "content-length": String(MAX_CHAT_VOICE_BYTES + 1) },
    body: new Uint8Array([1]),
  }));
  assert.equal(oversized.status, 413);
});

test("voice service records provider usage as voice transcription", async () => {
  const usage = [];
  const answer = await transcribeChatVoice("owner-1", validWav(), {}, {
    transcribe: async () => ({
      transcript: "spoken words",
      model: "voice-model",
      usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
    }),
    recordUsage: async (input) => usage.push(input),
  });
  assert.equal(answer.transcript, "spoken words");
  assert.equal(usage.length, 1);
  assert.equal(usage[0].ownerId, "owner-1");
  assert.equal(usage[0].requestKind, "voice_transcription");
  assert.equal(usage[0].model, "voice-model");
  assert.equal(usage[0].source, "exact");
});
