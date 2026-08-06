import "server-only";
import type { ChatResearchTraceEntry } from "../../../lib/chat-protocol";

export type SubagentTask = { id: string; title: string; prompt: string };
export type SubagentResult<T> = { task: SubagentTask; value?: T; error?: string };
export type SubagentTrace = ChatResearchTraceEntry;
export type SubagentStatus = "queued" | "running" | "completed" | "failed";
export type SubagentUpdate = {
  task: SubagentTask;
  status: SubagentStatus;
  summary?: string;
  summaryRevision?: number;
  trace?: SubagentTrace[];
};

async function emitUpdate(callback: ((update: SubagentUpdate) => Promise<void> | void) | undefined, update: SubagentUpdate): Promise<void> {
  try {
    await callback?.(update);
  } catch {
    // Presentation callbacks are best effort and must never fail a worker.
  }
}

export async function runSubagents<T>(input: {
  tasks: readonly SubagentTask[];
  signal?: AbortSignal;
  concurrency?: number;
  onUpdate?: (update: SubagentUpdate) => Promise<void> | void;
  worker: (task: SubagentTask, signal: AbortSignal) => Promise<T>;
}): Promise<SubagentResult<T>[]> {
  const controller = new AbortController();
  const abort = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener("abort", abort, { once: true });
  if (input.signal?.aborted) abort();
  const results: Array<SubagentResult<T> | undefined> = Array.from({ length: input.tasks.length });
  let cursor = 0;
  const limit = Math.max(1, Math.min(input.concurrency ?? 3, input.tasks.length || 1));
  const started = new Set<number>();

  // Queue the complete plan before any worker can begin. This gives the bridge a
  // stable inventory even when the run is cancelled before work starts.
  for (const task of input.tasks) await emitUpdate(input.onUpdate, { task, status: "queued" });

  const worker = async () => {
    while (!controller.signal.aborted) {
      const index = cursor++;
      const task = input.tasks[index];
      if (!task) return;
      started.add(index);
      await emitUpdate(input.onUpdate, { task, status: "running" });
      try {
        const value = await input.worker(task, controller.signal);
        results[index] = { task, value };
        await emitUpdate(input.onUpdate, { task, status: "completed", summary: "Research complete." });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Subagent failed.";
        results[index] = { task, error: message };
        await emitUpdate(input.onUpdate, { task, status: "failed", summary: message.slice(0, 240) });
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: limit }, worker));
    if (controller.signal.aborted) {
      for (let index = 0; index < input.tasks.length; index += 1) {
        if (started.has(index) || results[index]) continue;
        const task = input.tasks[index];
        results[index] = { task, error: "Subagent cancelled." };
        await emitUpdate(input.onUpdate, { task, status: "failed", summary: "Research cancelled." });
      }
    }
    return results.filter((result): result is SubagentResult<T> => Boolean(result));
  } finally {
    input.signal?.removeEventListener("abort", abort);
  }
}
