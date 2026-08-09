import "server-only";

import { randomUUID } from "node:crypto";
import { estimateUsageFromText } from "../../../lib/usage-pricing";
import type { ChatVoiceAnswer } from "../../../lib/chat-voice";
import { transcribeWithOpenRouter, OPENROUTER_VOICE_TRANSCRIPTION_PROMPT } from "../../providers/openrouter/openrouter-voice-adapter";
import { recordPromptUsage } from "../usage/prompt-cost-service";

export type ChatVoiceTranscriptionDependencies = {
  transcribe?: typeof transcribeWithOpenRouter;
  recordUsage?: typeof recordPromptUsage;
};

export async function transcribeChatVoice(
  ownerId: string,
  bytes: Uint8Array,
  options: { signal?: AbortSignal } = {},
  dependencies: ChatVoiceTranscriptionDependencies = {},
): Promise<ChatVoiceAnswer> {
  const answer = await (dependencies.transcribe ?? transcribeWithOpenRouter)(bytes, { signal: options.signal });
  const usage = answer.usage ?? estimateUsageFromText(OPENROUTER_VOICE_TRANSCRIPTION_PROMPT, answer.transcript);
  await (dependencies.recordUsage ?? recordPromptUsage)({
    ownerId,
    provider: "openrouter",
    model: answer.model ?? "openrouter/auto",
    requestKind: "voice_transcription",
    requestId: randomUUID(),
    round: 0,
    usage,
    source: answer.usage || answer.exactCostUsd !== undefined ? "exact" : "estimated",
    exactCostUsd: answer.exactCostUsd,
    unpriced: !answer.usage && answer.exactCostUsd === undefined,
  }).catch(() => undefined);
  return answer;
}
