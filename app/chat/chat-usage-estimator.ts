import type { ChatAssistantRound, ChatUsage } from "../../lib/chat-protocol";
import { estimateUsageFromCharacterCounts } from "../../lib/usage-pricing";

type ChatUsageEstimatorInput = {
  messages: unknown;
  systemPrompt: unknown;
  userPresence: unknown;
};

type ChatUsageEstimate = {
  replayRounds: readonly ChatAssistantRound[];
  systemInstructions: readonly string[];
  tools: readonly unknown[];
  output: string;
};

function serializedValue(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}

function serializedArrayLength(
  values: readonly unknown[],
  objectLengths: WeakMap<object, number>,
  primitiveLengths: Map<unknown, number>,
): number {
  let length = 2;
  for (const [index, value] of values.entries()) {
    if (index) length += 1;
    length += serializedValueLength(value, objectLengths, primitiveLengths);
  }
  return length;
}

function serializedValueLength(
  value: unknown,
  objectLengths: WeakMap<object, number>,
  primitiveLengths: Map<unknown, number>,
): number {
  const isObject = (typeof value === "object" && value !== null) || typeof value === "function";
  if (isObject) {
    const cached = objectLengths.get(value as object);
    if (cached !== undefined) return cached;
    const length = serializedValue(value).length;
    objectLengths.set(value as object, length);
    return length;
  }
  const cached = primitiveLengths.get(value);
  if (cached !== undefined) return cached;
  const length = serializedValue(value).length;
  primitiveLengths.set(value, length);
  return length;
}

/**
 * Estimates the chat request using the same JSON character count as the
 * legacy full-request fallback, while caching stable values and appending
 * replay rounds one at a time.
 */
export class ChatUsageEstimator {
  private readonly fixedRequestCharacters: number;
  private readonly replayRoundObjectLengths = new WeakMap<object, number>();
  private readonly replayRoundPrimitiveLengths = new Map<unknown, number>();
  private readonly instructionObjectLengths = new WeakMap<object, number>();
  private readonly instructionPrimitiveLengths = new Map<unknown, number>();
  private readonly toolObjectLengths = new WeakMap<object, number>();
  private readonly toolPrimitiveLengths = new Map<unknown, number>();
  private replayCharacters = 2;
  private replayRoundCount = 0;

  constructor(input: ChatUsageEstimatorInput) {
    this.fixedRequestCharacters = [
      '{"messages":',
      serializedValue(input.messages),
      ',"systemPrompt":',
      serializedValue(input.systemPrompt),
      ',"userPresence":',
      serializedValue(input.userPresence),
      ',"replayRounds":',
    ].join("").length;
  }

  estimate(input: ChatUsageEstimate): ChatUsage {
    this.appendReplayRounds(input.replayRounds);
    const systemInstructionsCharacters = serializedArrayLength(
      input.systemInstructions,
      this.instructionObjectLengths,
      this.instructionPrimitiveLengths,
    );
    const toolsCharacters = serializedArrayLength(
      input.tools,
      this.toolObjectLengths,
      this.toolPrimitiveLengths,
    );
    const requestCharacters = this.fixedRequestCharacters
      + this.replayCharacters
      + ',"systemInstructions":'.length
      + systemInstructionsCharacters
      + ',"tools":'.length
      + toolsCharacters
      + 1;
    return estimateUsageFromCharacterCounts(requestCharacters, input.output.length);
  }

  private appendReplayRounds(rounds: readonly ChatAssistantRound[]): void {
    for (; this.replayRoundCount < rounds.length; this.replayRoundCount += 1) {
      if (this.replayRoundCount) this.replayCharacters += 1;
      this.replayCharacters += serializedValueLength(
        rounds[this.replayRoundCount],
        this.replayRoundObjectLengths,
        this.replayRoundPrimitiveLengths,
      );
    }
  }
}
