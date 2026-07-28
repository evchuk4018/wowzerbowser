import "server-only";

import type { ChatStreamEvent } from "../../../lib/chat-protocol";
import {
  OpenRouterReasoningSummaryError,
  summarizeReasoningWithOpenRouter,
  type ReasoningSummaryAnswer,
} from "../../providers/openrouter/openrouter-reasoning-summary-adapter";
import { summarizeReasoningWithDeepSeekFlash } from "../../providers/deepseek/deepseek-reasoning-summary-adapter";

const FIRST_TITLE_DELAY_MS = 1_000;
const REFRESH_DELAY_MS = 3_000;
const FINAL_WAIT_MS = 5_000;
const MAX_TITLE_LENGTH = 120;

const PROMPT_PREFIX = `Summarize the assistant's current reasoning activity as one concise present-progress title.
Return only the title, with 4 to 12 words, no quotation marks, no Markdown, and no final-answer claim.
Describe the activity rather than repeating private details. Example: Debating how to edit the PDF.

Reasoning:
`;

export type ReasoningTitleUsage = ReasoningSummaryAnswer & { phase: number; revision: number };

type Options = {
  signal: AbortSignal;
  emit: (event: ChatStreamEvent) => Promise<void>;
  onUsage?: (usage: ReasoningTitleUsage) => Promise<void>;
  summarizeOpenRouter?: typeof summarizeReasoningWithOpenRouter;
  summarizeDeepSeek?: typeof summarizeReasoningWithDeepSeekFlash;
  firstDelayMs?: number;
  refreshDelayMs?: number;
  finalWaitMs?: number;
};

function cleanTitle(value: string): string | null {
  const title = value.replace(/^["'`]+|["'`]+$/g, "").replace(/\s+/g, " ").trim();
  if (!title || title.length > MAX_TITLE_LENGTH) return null;
  const words = title.split(" ");
  return words.length >= 2 && words.length <= 16 ? title : null;
}

export class ReasoningTitleCoordinator {
  private phase = 1;
  private text = "";
  private revision = 0;
  private summarizedRevision = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private phaseStartedAt = 0;
  private lastStartedAt = 0;
  private readonly summarizeOpenRouter;
  private readonly summarizeDeepSeek;

  constructor(private readonly options: Options) {
    this.summarizeOpenRouter = options.summarizeOpenRouter ?? summarizeReasoningWithOpenRouter;
    this.summarizeDeepSeek = options.summarizeDeepSeek ?? summarizeReasoningWithDeepSeekFlash;
  }

  append(delta: string): void {
    if (!delta || this.options.signal.aborted) return;
    if (!this.text) this.phaseStartedAt = Date.now();
    this.text += delta;
    this.revision += 1;
    this.schedule();
  }

  async breakPhase(nextPhase: number): Promise<void> {
    await this.flush();
    this.clearTimer();
    this.phase = nextPhase;
    this.text = "";
    this.revision = 0;
    this.summarizedRevision = 0;
    this.phaseStartedAt = 0;
    this.lastStartedAt = 0;
  }

  async finish(): Promise<void> {
    await this.flush();
    this.clearTimer();
  }

  cancel(): void {
    this.clearTimer();
  }

  private schedule(): void {
    if (this.timer || this.inFlight || this.revision <= this.summarizedRevision) return;
    const now = Date.now();
    const dueAt = this.lastStartedAt
      ? this.lastStartedAt + (this.options.refreshDelayMs ?? REFRESH_DELAY_MS)
      : this.phaseStartedAt + (this.options.firstDelayMs ?? FIRST_TITLE_DELAY_MS);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.start();
    }, Math.max(0, dueAt - now));
  }

  private async start(): Promise<void> {
    if (this.inFlight || !this.text || this.options.signal.aborted) return;
    const phase = this.phase;
    const revision = this.revision;
    const monologue = this.text;
    this.lastStartedAt = Date.now();
    this.inFlight = (async () => {
      try {
        let answer: ReasoningSummaryAnswer;
        try {
          answer = await this.summarizeOpenRouter(`${PROMPT_PREFIX}${monologue}`, this.options.signal);
        } catch (error) {
          if (!(error instanceof OpenRouterReasoningSummaryError) || error.status !== 429) return;
          answer = await this.summarizeDeepSeek(`${PROMPT_PREFIX}${monologue}`, this.options.signal);
        }
        const summary = cleanTitle(answer.summary);
        if (!summary) return;
        await this.options.onUsage?.({ ...answer, phase, revision });
        if (phase === this.phase && revision >= this.summarizedRevision && !this.options.signal.aborted) {
          this.summarizedRevision = revision;
          await this.options.emit({ type: "phase_summary", phase, summary, revision });
        }
      } catch {
        // Titles are best-effort presentation metadata and never fail the main run.
      } finally {
        this.inFlight = null;
        this.schedule();
      }
    })();
    await this.inFlight;
  }

  private async flush(): Promise<void> {
    this.clearTimer();
    if (this.inFlight) {
      await Promise.race([this.inFlight, new Promise<void>((resolve) => setTimeout(resolve, this.options.finalWaitMs ?? FINAL_WAIT_MS))]);
    }
    if (this.revision <= this.summarizedRevision || this.options.signal.aborted) return;
    await Promise.race([this.start(), new Promise<void>((resolve) => setTimeout(resolve, this.options.finalWaitMs ?? FINAL_WAIT_MS))]);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
