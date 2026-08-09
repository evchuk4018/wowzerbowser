import type { ChatUsage } from "./chat-protocol";

export const CHAT_VOICE_CONTENT_TYPE = "audio/wav" as const;
export const CHAT_VOICE_FORMAT = "wav" as const;
export const MAX_CHAT_VOICE_BYTES = 10 * 1024 * 1024;
export const MAX_CHAT_VOICE_DURATION_MS = 2 * 60 * 1_000;
export const OPENROUTER_VOICE_TIMEOUT_MS = 45_000;
export const MAX_CHAT_VOICE_TRANSCRIPT_CHARACTERS = 32_000;

export type ChatVoiceAnswer = {
  transcript: string;
  model: string | null;
  usage: ChatUsage | null;
  exactCostUsd?: number;
};

export class ChatVoiceError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "ChatVoiceError";
    this.code = code;
    this.status = status;
  }
}

function isWav(bytes: Uint8Array): boolean {
  return bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45;
}

function validateWavHeader(bytes: Uint8Array): void {
  if (bytes.byteLength < 46) throw new ChatVoiceError("invalid_audio", "The voice recording could not be read.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fmtChunk = view.getUint32(12, false);
  const dataChunk = view.getUint32(36, false);
  const audioFormat = view.getUint16(20, true);
  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);
  const dataSize = view.getUint32(40, true);
  if (fmtChunk !== 0x666d7420 || dataChunk !== 0x64617461 || audioFormat !== 1 || channels < 1 || sampleRate < 1 || bitsPerSample !== 16 || dataSize < 1 || dataSize > bytes.byteLength - 44) {
    throw new ChatVoiceError("invalid_audio", "The voice recording could not be read.");
  }
  const durationMs = dataSize / (sampleRate * channels * 2) * 1_000;
  if (durationMs > MAX_CHAT_VOICE_DURATION_MS) {
    throw new ChatVoiceError("audio_too_long", "Voice recordings must be 2 minutes or shorter.", 413);
  }
}

export function validateChatVoiceBytes(bytes: Uint8Array, declaredType?: string): void {
  if (bytes.byteLength === 0) throw new ChatVoiceError("empty_audio", "The voice recording is empty.");
  if (bytes.byteLength > MAX_CHAT_VOICE_BYTES) {
    throw new ChatVoiceError("audio_too_large", "Voice recordings must be 10 MB or smaller.", 413);
  }
  if (declaredType && declaredType.toLowerCase() !== CHAT_VOICE_CONTENT_TYPE) {
    throw new ChatVoiceError("unsupported_audio", "The voice recording format is not supported.");
  }
  if (!isWav(bytes)) throw new ChatVoiceError("invalid_audio", "The voice recording could not be read.");
  validateWavHeader(bytes);
}

export function appendChatVoiceTranscript(draft: string, transcript: string): string {
  const next = transcript.trim();
  if (!next) return draft;
  if (!draft) return next;
  return /\s$/.test(draft) ? `${draft}${next}` : `${draft}\n${next}`;
}
