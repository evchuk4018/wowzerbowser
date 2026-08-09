const RECORDING_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/ogg;codecs=opus",
  "audio/mp4",
  "audio/webm",
  "audio/ogg",
] as const;
const VOICE_WAV_SAMPLE_RATE = 16_000;

type AudioContextConstructor = new () => AudioContext;

function audioContextConstructor(): AudioContextConstructor | null {
  if (typeof window === "undefined") return null;
  const candidate = window.AudioContext
    ?? (window as Window & { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext;
  return candidate ?? null;
}

export function supportedVoiceRecordingMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return RECORDING_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
}

export function encodePcmWav(channels: readonly Float32Array[], sampleRate: number): Blob {
  if (!channels.length || !channels[0]?.length || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error("The voice recording contained no audio samples.");
  }
  const channelCount = Math.min(channels.length, 2);
  const frameCount = Math.min(...channels.slice(0, channelCount).map((channel) => channel.length));
  if (!frameCount) throw new Error("The voice recording contained no audio samples.");
  const bytesPerSample = 2;
  const blockAlign = channelCount * bytesPerSample;
  const dataSize = frameCount * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, Math.round(sampleRate), true);
  view.setUint32(28, Math.round(sampleRate) * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const sample = Math.max(-1, Math.min(1, channels[channel][frame] ?? 0));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += bytesPerSample;
    }
  }
  return new Blob([buffer], { type: "audio/wav" });
}

export async function convertRecordedAudioToWav(recording: Blob): Promise<Blob> {
  const AudioContextClass = audioContextConstructor();
  if (!AudioContextClass) throw new Error("This browser cannot process microphone recordings.");
  const context = new AudioContextClass();
  try {
    const decoded = await context.decodeAudioData(await recording.arrayBuffer());
    const targetSampleRate = Math.min(decoded.sampleRate, VOICE_WAV_SAMPLE_RATE);
    const channels = Array.from({ length: Math.min(decoded.numberOfChannels, 2) }, (_, index) => {
      const source = decoded.getChannelData(index);
      if (targetSampleRate === decoded.sampleRate) return source;
      const targetLength = Math.max(1, Math.ceil(source.length * targetSampleRate / decoded.sampleRate));
      const target = new Float32Array(targetLength);
      for (let targetIndex = 0; targetIndex < targetLength; targetIndex += 1) {
        const sourcePosition = targetIndex * decoded.sampleRate / targetSampleRate;
        const lower = Math.floor(sourcePosition);
        const upper = Math.min(source.length - 1, lower + 1);
        const fraction = sourcePosition - lower;
        target[targetIndex] = (source[lower] ?? 0) * (1 - fraction) + (source[upper] ?? 0) * fraction;
      }
      return target;
    });
    return encodePcmWav(channels, targetSampleRate);
  } finally {
    await context.close().catch(() => undefined);
  }
}

export type VoiceRecordingSession = {
  stop: () => Promise<Blob>;
  cancel: () => void;
};

export async function startVoiceRecording(): Promise<VoiceRecordingSession> {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    throw new Error("Voice input is not supported by this browser.");
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mimeType = supportedVoiceRecordingMimeType();
  let recorder: MediaRecorder;
  try {
    recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    throw error;
  }
  const chunks: Blob[] = [];
  let settled = false;
  let stopPromise: Promise<Blob> | null = null;
  const stopped = new Promise<Blob>((resolve, reject) => {
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });
    recorder.addEventListener("error", () => reject(new Error("The microphone recording failed.")), { once: true });
    recorder.addEventListener("stop", () => {
      stream.getTracks().forEach((track) => track.stop());
      if (!settled) {
        settled = true;
        resolve(new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" }));
      }
    }, { once: true });
  });
  try {
    recorder.start();
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    throw error;
  }
  return {
    stop: () => {
      if (!stopPromise) {
        if (recorder.state === "recording") recorder.stop();
        stopPromise = stopped;
      }
      return stopPromise;
    },
    cancel: () => {
      if (recorder.state !== "inactive") recorder.stop();
      stream.getTracks().forEach((track) => track.stop());
    },
  };
}
