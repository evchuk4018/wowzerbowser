import { NextResponse } from "next/server";
import { authorizeOwnerSession } from "../../../auth/owner-auth-service";
import {
  CHAT_VOICE_CONTENT_TYPE,
  ChatVoiceError,
  MAX_CHAT_VOICE_BYTES,
  validateChatVoiceBytes,
} from "../../../../lib/chat-voice";
import { transcribeChatVoice } from "../../../server/chat/chat-voice-service";

export const runtime = "nodejs";
export const maxDuration = 60;

function declaredContentLength(request: Request): number | null {
  const value = request.headers.get("content-length");
  if (value === null) return null;
  if (!/^\d+$/.test(value.trim())) throw new ChatVoiceError("invalid_content_length", "The voice recording size is invalid.");
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_CHAT_VOICE_BYTES) {
    throw new ChatVoiceError("audio_too_large", "Voice recordings must be 10 MB or smaller.", 413);
  }
  return size;
}

async function readBoundedBody(request: Request): Promise<Uint8Array> {
  declaredContentLength(request);
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > MAX_CHAT_VOICE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new ChatVoiceError("audio_too_large", "Voice recordings must be 10 MB or smaller.", 413);
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function createChatVoiceTranscriptionHandler(dependencies = {
  authorizeOwnerSession,
  transcribeChatVoice,
}) {
  return async function POST(request: Request) {
    const owner = await dependencies.authorizeOwnerSession(request);
    if (!owner) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== CHAT_VOICE_CONTENT_TYPE) {
      return NextResponse.json({ error: "Voice recordings must use WAV audio." }, { status: 400 });
    }
    try {
      const bytes = await readBoundedBody(request);
      validateChatVoiceBytes(bytes, contentType);
      const answer = await dependencies.transcribeChatVoice(owner.id, bytes, { signal: request.signal });
      return NextResponse.json({ transcript: answer.transcript, model: answer.model });
    } catch (error) {
      if (error instanceof ChatVoiceError) return NextResponse.json({ error: error.message }, { status: error.status });
      const status = error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : 503;
      return NextResponse.json({ error: "The voice recording could not be transcribed." }, { status });
    }
  };
}

export const POST = createChatVoiceTranscriptionHandler();
